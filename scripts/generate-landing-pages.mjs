#!/usr/bin/env node

import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const templatePath = path.join(rootDir, "templates", "product-page.template.html");
const defaultInputPath = path.join(rootDir, "data", "test-product.json");
const outputDir = path.join(rootDir, "products");
const sitemapPath = path.join(rootDir, "sitemap.xml");
const robotsPath = path.join(rootDir, "robots.txt");

const DEFAULT_SITE_URL = "https://discor.com.ar";
const DEFAULT_API_PATH = "/api/products/landing/pages";
const DEFAULT_API_LIMIT = 100;
const DEFAULT_RETRIES = 5;
const DEFAULT_RETRY_DELAY_MS = 1200;

main().catch((error) => {
  console.error(`[landing-pages] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = resolveSource(args);
  const siteUrl = trimTrailingSlash(args.siteUrl ?? process.env.SITE_URL ?? DEFAULT_SITE_URL);
  const imageBaseUrl = trimTrailingSlash(args.imageBaseUrl ?? process.env.LANDING_PAGE_IMAGE_BASE_URL ?? siteUrl);

  if (source === "api" && args.output) {
    throw new Error("--output is only valid for file source mode.");
  }

  if (args.output) {
    const base = path.basename(args.output);
    if (base !== args.output || args.output.includes("..") || path.isAbsolute(args.output)) {
      throw new Error("--output must be a plain filename with no path separators or traversal sequences.");
    }
  }

  const template = await readFile(templatePath, "utf8");
  const products = await loadProducts({ source, args });

  if (products.length === 0) {
    throw new Error("No products found to generate pages.");
  }

  if (args.output && products.length !== 1) {
    throw new Error("--output can only be used when exactly one product is loaded.");
  }

  await mkdir(outputDir, { recursive: true });

  if (source === "api") {
    await removeExistingGeneratedPages();
  }

  const usedFileNames = new Set();
  const generatedPages = [];

  for (const product of products) {
    const pageData = mapProductToTemplateData(product, {
      baseUrl: siteUrl,
      imageBaseUrl,
      outputOverride: args.output,
      usedFileNames
    });

    const html = renderTemplate(template, pageData.templateValues);
    const filePath = path.join(outputDir, pageData.fileName);
    await writeFile(filePath, html, "utf8");

    generatedPages.push(pageData.pageMeta);
    console.log(`Generated ${path.relative(rootDir, filePath)}`);
  }

  if (source === "api") {
    const productIndexHtml = renderProductIndexPage(generatedPages, siteUrl);
    const productIndexPath = path.join(outputDir, "index.html");
    await writeFile(productIndexPath, productIndexHtml, "utf8");
    console.log(`Generated ${path.relative(rootDir, productIndexPath)}`);

    const sitemapXml = renderSitemapXml(generatedPages, siteUrl);
    await writeFile(sitemapPath, sitemapXml, "utf8");
    console.log(`Generated ${path.relative(rootDir, sitemapPath)}`);

    const robotsTxt = renderRobotsTxt(siteUrl);
    await writeFile(robotsPath, robotsTxt, "utf8");
    console.log(`Generated ${path.relative(rootDir, robotsPath)}`);

    const searchIndexJson = renderSearchIndex(generatedPages);
    const searchIndexPath = path.join(outputDir, "search-index.json");
    await writeFile(searchIndexPath, searchIndexJson, "utf8");
    console.log(`Generated ${path.relative(rootDir, searchIndexPath)}`);

    console.log(`[landing-pages] Generated ${generatedPages.length} product pages from API.`);
  }
}

function parseArgs(rawArgs) {
  const options = {};

  for (let i = 0; i < rawArgs.length; i += 1) {
    const token = rawArgs[i];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const value = rawArgs[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }

    if (key === "input") {
      options.input = value;
    } else if (key === "site-url") {
      options.siteUrl = value;
    } else if (key === "output") {
      options.output = value;
    } else if (key === "source") {
      if (value !== "file" && value !== "api") {
        throw new Error("--source must be either 'file' or 'api'.");
      }
      options.source = value;
    } else if (key === "api-base-url") {
      options.apiBaseUrl = value;
    } else if (key === "api-path") {
      options.apiPath = value;
    } else if (key === "api-token") {
      options.apiToken = value;
    } else if (key === "image-base-url") {
      options.imageBaseUrl = value;
    } else if (key === "limit") {
      options.limit = parsePositiveInteger(value, "limit");
    } else if (key === "max-pages") {
      options.maxPages = parsePositiveInteger(value, "max-pages");
    } else if (key === "retries") {
      options.retries = parseNonNegativeInteger(value, "retries");
    } else if (key === "retry-delay-ms") {
      options.retryDelayMs = parsePositiveInteger(value, "retry-delay-ms");
    } else {
      throw new Error(`Unknown option: --${key}`);
    }

    i += 1;
  }

  return options;
}

function resolveSource(args) {
  if (args.source) {
    return args.source;
  }

  if (args.apiBaseUrl || process.env.LANDING_PAGE_API_BASE_URL) {
    return "api";
  }

  return "file";
}

async function loadProducts({ source, args }) {
  if (source === "api") {
    const apiBaseUrl = trimTrailingSlash(args.apiBaseUrl ?? process.env.LANDING_PAGE_API_BASE_URL ?? "");
    const apiToken = args.apiToken ?? process.env.LANDING_PAGE_TOKEN ?? "";

    if (!apiBaseUrl) {
      throw new Error("Missing API base URL. Set --api-base-url or LANDING_PAGE_API_BASE_URL.");
    }

    if (!apiToken) {
      throw new Error("Missing landing API token. Set --api-token or LANDING_PAGE_TOKEN.");
    }

    const apiPath = args.apiPath ?? process.env.LANDING_PAGE_API_PATH ?? DEFAULT_API_PATH;
    const limit = Math.min(args.limit ?? DEFAULT_API_LIMIT, 100);
    const maxPages = args.maxPages ?? null;
    const retries = args.retries ?? DEFAULT_RETRIES;
    const retryDelayMs = args.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

    return await fetchAllLandingProducts({
      apiBaseUrl,
      apiPath,
      apiToken,
      limit,
      maxPages,
      retries,
      retryDelayMs
    });
  }

  const inputPath = path.resolve(rootDir, args.input ?? path.relative(rootDir, defaultInputPath));
  const rawInput = await readFile(inputPath, "utf8");
  const parsedInput = JSON.parse(rawInput);
  return normalizeProducts(parsedInput);
}

async function fetchAllLandingProducts({
  apiBaseUrl,
  apiPath,
  apiToken,
  limit,
  maxPages,
  retries,
  retryDelayMs
}) {
  const items = [];
  let page = 1;
  let totalPages = 1;

  do {
    const requestUrl = buildLandingPageUrl(apiBaseUrl, apiPath, page, limit);
    const payload = await fetchJsonWithRetry({
      url: requestUrl,
      apiToken,
      retries,
      retryDelayMs
    });

    const chunk = normalizeProducts(payload);
    items.push(...chunk);

    const nextTotal = Number(payload?.pagination?.totalPages);
    totalPages = Number.isInteger(nextTotal) && nextTotal > 0 ? nextTotal : page;

    console.log(`[landing-pages] API page ${page}/${totalPages} fetched (${chunk.length} products).`);

    page += 1;
  } while (page <= totalPages && (!maxPages || page <= maxPages));

  return dedupeProducts(items);
}

function buildLandingPageUrl(apiBaseUrl, apiPath, page, limit) {
  const base = new URL(apiBaseUrl);
  const normalizedPath = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  const requestUrl = new URL(normalizedPath, base);
  requestUrl.searchParams.set("page", String(page));
  requestUrl.searchParams.set("limit", String(limit));
  return requestUrl.toString();
}

async function fetchJsonWithRetry({ url, apiToken, retries, retryDelayMs }) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        Accept: "application/json"
      }
    });

    if (response.ok) {
      return await response.json();
    }

    const bodyText = await safeReadResponseText(response);
    const isLastAttempt = attempt === retries;
    const retryable = isRetryableStatus(response.status);

    if (!retryable || isLastAttempt) {
      throw new Error(`API request failed (${response.status}) at ${url}. ${bodyText}`.trim());
    }

    const delay = getRetryDelayMs(response, attempt, retryDelayMs);
    console.warn(`[landing-pages] Retry ${attempt + 1}/${retries} after ${delay}ms (${response.status})`);
    await sleep(delay);
  }

  throw new Error(`Unexpected retry termination for ${url}`);
}

function isRetryableStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function getRetryDelayMs(response, attempt, baseDelayMs) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.ceil(seconds * 1000);
    }
  }

  const exponential = baseDelayMs * (2 ** attempt);
  const jitter = Math.floor(Math.random() * 300);
  return exponential + jitter;
}

async function safeReadResponseText(response) {
  try {
    const text = await response.text();
    return text.slice(0, 280).replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

function dedupeProducts(products) {
  const seen = new Set();
  const unique = [];

  for (const product of products) {
    const key = `${product?.id ?? ""}|${product?.sku ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(product);
  }

  return unique;
}

async function removeExistingGeneratedPages() {
  const entries = await readdir(outputDir, { withFileTypes: true });

  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
      .map((entry) => unlink(path.join(outputDir, entry.name)))
  );
}

function normalizeProducts(input) {
  if (Array.isArray(input)) {
    return input;
  }

  if (input && Array.isArray(input.data)) {
    return input.data;
  }

  if (input && typeof input === "object") {
    return [input];
  }

  return [];
}

function mapProductToTemplateData(product, { baseUrl, imageBaseUrl, outputOverride, usedFileNames }) {
  const productName = pickLocaleText(product.name, "Producto sin nombre");
  const productDescription = pickLocaleText(product.description, "Sin descripción disponible.");
  const sku = cleanText(product.sku, "N/A");
  const brand = pickLocaleText(product.brand?.name, "Sin marca");
  const category = pickLocaleText(product.category?.name, "Sin categoría");
  const compatibilities = Array.isArray(product.compatibilities) ? product.compatibilities : [];
  const attributes = product.attributes ?? {};
  const preferredSlug = buildSeoSlug(productName, sku, compatibilities) || slugify(product.id) || "producto";
  const preferredFileName = outputOverride ?? `${preferredSlug}.html`;
  const fileName = ensureUniqueFileName(preferredFileName, usedFileNames, product.id);
  const canonicalUrl = `${baseUrl}/products/${fileName}`;
  const productImageUrl = `${imageBaseUrl ?? baseUrl}/${sku}.jpg`;
  const productImageAlt = cleanText(product.image?.alt, `Imagen de ${productName}`);
  const wholesaleCtaUrl = cleanText(product.wholesaleCtaUrl, "https://clientes.discor.com.ar");
  const wholesaleCtaText = cleanText(product.wholesaleCtaText, "Acceder al Área Clientes");
  const currentYear = new Date().getUTCFullYear();

  const brands = new Set();
  const models = new Set();
  const years = new Set();
  const locations = new Set();

  const compatibilityRows = compatibilities.map((item) => {
    const vehicleGeneration = item.vehicleGeneration ?? {};
    const vehicleModel = vehicleGeneration.vehicleModel ?? {};
    const vehicleBrand = vehicleModel.vehicleBrand ?? {};

    const compBrand = cleanText(vehicleBrand.name, "N/D");
    const compModel = cleanText(vehicleModel.name, "N/D");
    const compGeneration = cleanText(vehicleGeneration.generationName, "N/D");
    const compLocation = cleanText(item.vehicleLocation?.name, "N/D");
    const yearStart = parseYear(vehicleGeneration.yearStart) ?? currentYear;
    const yearEndValue = parseYear(vehicleGeneration.yearEnd);
    const yearEnd = Math.max(yearStart, yearEndValue ?? currentYear);
    const yearEndLabel = yearEndValue == null ? "Actual" : String(yearEnd);

    brands.add(compBrand);
    models.add(compModel);
    locations.add(compLocation);

    for (let y = yearStart; y <= yearEnd; y += 1) {
      years.add(y);
    }

    return [
      `<tr data-brand="${escapeAttr(compBrand)}"`,
      `data-model="${escapeAttr(compModel)}"`,
      `data-location="${escapeAttr(compLocation)}"`,
      `data-year-start="${yearStart}"`,
      `data-year-end="${yearEnd}">`,
      `<td>${escapeHtml(compBrand)}</td>`,
      `<td>${escapeHtml(compModel)}</td>`,
      `<td>${escapeHtml(compGeneration)}</td>`,
      `<td>${yearStart}</td>`,
      `<td>${yearEndLabel}</td>`,
      `<td>${escapeHtml(compLocation)}</td>`,
      "</tr>"
    ].join(" ");
  });

  const attributePills = Object.entries(attributes).map(([key, value]) => {
    return `<span class="attribute-pill">${escapeHtml(String(key))}: ${escapeHtml(String(value))}</span>`;
  });

  const noImageSvg = `<div class="no-image"><svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.2"><path stroke-linecap="round" stroke-linejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z"/></svg><span>Sin imagen disponible</span></div>`;
  const hasRealImage = true; // always attempt: onerror handles missing images
  const productImageHtml = hasRealImage
    ? `<img src="${escapeAttr(productImageUrl)}" alt="${escapeAttr(productImageAlt)}" loading="eager" onerror="this.style.display='none';this.nextElementSibling.hidden=false">\n${noImageSvg.replace('<div class="no-image">', '<div class="no-image" hidden>')}`
    : noImageSvg;
  const attributesSection = attributePills.length > 0
    ? `<div class="attributes">${attributePills.join("\n        ")}</div>`
    : "";

  const seoTitle = buildSeoTitle(productName, compatibilities);
  const seoDescription = buildSeoDescription(productName, productDescription, sku, category, compatibilities);
  const compatibilityCountLabel = `${compatibilities.length} compatibilidades`;

  const vehicleCompat = compatibilities.map((item) => {
    const vg = item.vehicleGeneration ?? {};
    const vm = vg.vehicleModel ?? {};
    const vb = vm.vehicleBrand ?? {};
    const ys = parseYear(vg.yearStart) ?? currentYear;
    const yeRaw = parseYear(vg.yearEnd);
    const ye = Math.max(ys, yeRaw ?? currentYear);
    return { b: cleanText(vb.name, "N/D"), m: cleanText(vm.name, "N/D"), ys, ye };
  });

  const schema = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: productName,
    description: productDescription,
    sku,
    category,
    image: productImageUrl,
    brand: {
      "@type": "Brand",
      name: brand
    },
    additionalProperty: Object.entries(attributes).map(([key, value]) => ({
      "@type": "PropertyValue",
      name: String(key),
      value: String(value)
    })),
    isCompatibleWith: compatibilities.map((item) => {
      const vehicleGeneration = item.vehicleGeneration ?? {};
      const vehicleModel = vehicleGeneration.vehicleModel ?? {};
      const vehicleBrand = vehicleModel.vehicleBrand ?? {};
      const start = parseYear(vehicleGeneration.yearStart) ?? currentYear;
      const endValue = parseYear(vehicleGeneration.yearEnd);
      const end = Math.max(start, endValue ?? currentYear);
      const generationName = cleanText(vehicleGeneration.generationName, "");
      const parts = [vehicleBrand.name, vehicleModel.name, generationName, `${start}-${endValue == null ? "Actual" : end}`]
        .filter(Boolean)
        .map((part) => String(part).trim());
      return parts.join(" ");
    })
  };

  return {
    fileName,
    pageMeta: {
      id: String(product.id ?? ""),
      fileName,
      url: canonicalUrl,
      title: productName,
      description: productDescription,
      sku,
      brand,
      category,
      vehicleCompat,
      updatedAt: normalizeDate(product.updatedAt)
    },
    templateValues: {
      SEO_TITLE: escapeAttr(seoTitle),
      SEO_DESCRIPTION: escapeAttr(seoDescription),
      CANONICAL_URL: escapeAttr(canonicalUrl),
      OG_IMAGE_URL: escapeAttr(productImageUrl),
      ASSET_PREFIX: "../",
      PRODUCT_JSON_LD: safeJsonLd(schema),
      PRODUCT_NAME: escapeHtml(productName),
      PRODUCT_DESCRIPTION: escapeHtml(productDescription),
      PRODUCT_SKU: escapeHtml(sku),
      PRODUCT_BRAND: escapeHtml(brand),
      PRODUCT_CATEGORY: escapeHtml(category),
      PRODUCT_IMAGE_HTML: productImageHtml,
      WHOLESALE_CTA_URL: escapeAttr(wholesaleCtaUrl),
      WHOLESALE_CTA_TEXT: escapeHtml(wholesaleCtaText),
      ATTRIBUTES_SECTION: attributesSection,
      FILTER_BRAND_OPTIONS: renderOptionList(brands),
      FILTER_MODEL_OPTIONS: renderOptionList(models),
      FILTER_YEAR_OPTIONS: renderOptionList(years),
      FILTER_LOCATION_OPTIONS: renderOptionList(locations),
      COMPATIBILITY_ROWS: compatibilityRows.length > 0
        ? compatibilityRows.join("\n            ")
        : '<tr><td colspan="6">Sin compatibilidades disponibles.</td></tr>',
      COMPATIBILITY_COUNT_LABEL: escapeHtml(compatibilityCountLabel)
    }
  };
}

function resolveImageCandidate(product) {
  const firstGalleryImage = Array.isArray(product.images) && product.images.length > 0
    ? (product.images[0]?.url ?? product.images[0])
    : null;

  return product.image?.url ?? product.imageUrl ?? firstGalleryImage ?? "/img/intro-discor.jpg";
}

function ensureUniqueFileName(preferredFileName, usedFileNames, productId) {
  const normalizedPreferred = preferredFileName.endsWith(".html") ? preferredFileName : `${preferredFileName}.html`;
  const base = normalizedPreferred.replace(/\.html$/, "");
  const fallback = slugify(productId) || "producto";

  let candidate = normalizedPreferred;
  let suffix = 2;

  while (usedFileNames.has(candidate)) {
    candidate = `${base}-${fallback.slice(0, 8)}-${suffix}.html`;
    suffix += 1;
  }

  usedFileNames.add(candidate);
  return candidate;
}

function normalizeDate(value) {
  if (typeof value !== "string") {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
}

function renderSearchIndex(pages) {
  const entries = pages.map((page) => ({
    url: page.fileName,
    name: page.title,
    sku: page.sku,
    brand: page.brand,
    category: page.category,
    description: page.description,
    vehicleCompat: page.vehicleCompat ?? []
  }));
  return JSON.stringify(entries);
}

function renderProductIndexPage(pages, siteUrl) {
  const sorted = pages.slice().sort((a, b) => a.title.localeCompare(b.title, "es"));

  // Build vehicle brand → models map
  const brandModelMap = {};
  for (const page of sorted) {
    for (const c of (page.vehicleCompat ?? [])) {
      if (!brandModelMap[c.b]) brandModelMap[c.b] = new Set();
      brandModelMap[c.b].add(c.m);
    }
  }
  const brandModels = {};
  for (const [b, ms] of Object.entries(brandModelMap)) {
    brandModels[b] = [...ms].sort((a, b) => a.localeCompare(b, "es"));
  }

  // Build vehicle brand → model → years map
  const modelYearsMap = {};
  for (const page of sorted) {
    for (const c of (page.vehicleCompat ?? [])) {
      if (!modelYearsMap[c.b]) modelYearsMap[c.b] = {};
      if (!modelYearsMap[c.b][c.m]) modelYearsMap[c.b][c.m] = new Set();
      for (let y = c.ys; y <= c.ye; y++) modelYearsMap[c.b][c.m].add(y);
    }
  }
  const modelYears = {};
  for (const [b, models] of Object.entries(modelYearsMap)) {
    modelYears[b] = {};
    for (const [m, yrs] of Object.entries(models)) {
      modelYears[b][m] = [...yrs].sort((a, b) => b - a);
    }
  }

  const vehicleBrands = Object.keys(brandModels).sort((a, b) => a.localeCompare(b, "es"));

  const cards = sorted.map((page) => {
    const compatJson = escapeAttr(JSON.stringify(page.vehicleCompat ?? []));
    return [
      `<article class="card" data-name="${escapeAttr(page.title.toLowerCase())}"`,
      `data-sku="${escapeAttr(page.sku.toLowerCase())}"`,
      `data-brand="${escapeAttr(page.brand)}"`,
      `data-category="${escapeAttr(page.category)}"`,
      `data-compat="${compatJson}">`,
      `<p class="sku">SKU ${escapeHtml(page.sku)}</p>`,
      `<h2><a href="./${escapeAttr(page.fileName)}">${escapeHtml(page.title)}</a></h2>`,
      `<p class="desc">${escapeHtml(page.description)}</p>`,
      `<div class="card-meta"><span class="pill">${escapeHtml(page.brand)}</span><span class="pill">${escapeHtml(page.category)}</span></div>`,
      `<a class="card-link" href="./${escapeAttr(page.fileName)}">Ver ficha →</a>`,
      "</article>"
    ].join(" ");
  }).join("\n");

  const categories = [...new Set(sorted.map((p) => p.category))].sort((a, b) => a.localeCompare(b, "es"));
  const categoryOptions = categories.map((c) => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join("");
  const vehicleBrandOptions = vehicleBrands.map((b) => `<option value="${escapeAttr(b)}">${escapeHtml(b)}</option>`).join("");
  const now = new Date().toISOString().slice(0, 10);
  const brandModelsJson = JSON.stringify(brandModels).replaceAll("</script", "<\\/script");
  const modelYearsJson = JSON.stringify(modelYears).replaceAll("</script", "<\\/script");

  return `<!doctype html>
<html lang="es-AR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Catálogo de Autopartes y Cerrajería | DisCor Mayorista</title>
  <meta name="description" content="Catálogo mayorista de autopartes, cerrajería y accesorios con compatibilidades por vehículo. DisCor — Córdoba.">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="${escapeAttr(`${siteUrl}/products/`)}">
  <link rel="icon" type="image/png" sizes="32x32" href="../img/favicon-32x32.png">
  <style>
    @font-face { font-family:'Inter'; font-style:normal; font-weight:400; font-display:swap; src:local(''),url('../fonts/inter-v12-latin-300.woff2') format('woff2'); }
    @font-face { font-family:'Inter'; font-style:normal; font-weight:700; font-display:swap; src:local(''),url('../fonts/inter-v12-latin-700.woff2') format('woff2'); }

    :root {
      --green:#00ac41; --deep:#006024; --dark:#002b10;
      --ink:#111814; --muted:#5a6b61; --line:#daeae2; --soft:#f4fbf7;
    }
    *, *::before, *::after { box-sizing:border-box; margin:0; }
    body { font-family:'Inter','Segoe UI',sans-serif; color:var(--ink); background:linear-gradient(180deg,#f8fcfa 0,#f2faf5 100%); min-height:100vh; }
    a { color:inherit; text-decoration:none; }
    .wrap { width:min(calc(100% - 2.5rem),1120px); margin:0 auto; }

    /* Nav */
    .site-nav { position:sticky; top:0; z-index:100; background:rgba(255,255,255,.96); backdrop-filter:blur(8px); border-bottom:1px solid var(--line); }
    .nav-row { height:68px; display:flex; align-items:center; justify-content:space-between; gap:1rem; }
    .nav-brand { display:flex; align-items:center; gap:.6rem; }
    .nav-brand img { height:34px; }
    .nav-brand span { font-size:.82rem; color:var(--muted); padding-left:.6rem; border-left:1px solid var(--line); }
    .nav-cta { background:var(--green); color:#fff!important; font-weight:700; font-size:.88rem; padding:.5rem 1.1rem; border-radius:999px; transition:background .2s; }
    .nav-cta:hover { background:var(--deep); }

    /* Search / filter bar */
    .search-bar { background:#fff; border-bottom:1px solid var(--line); padding:.85rem 0 .75rem; }
    .search-input-wrap { position:relative; margin-bottom:.65rem; }
    .search-input-wrap svg { position:absolute; left:.75rem; top:50%; transform:translateY(-50%); color:var(--muted); pointer-events:none; }
    input[type=search] {
      width:100%; padding:.58rem .75rem .58rem 2.25rem;
      border:1px solid var(--line); border-radius:10px;
      font-family:inherit; font-size:.92rem; color:var(--ink);
      background:#fff; transition:border-color .2s, box-shadow .2s;
    }
    input[type=search]:focus { outline:none; border-color:var(--green); box-shadow:0 0 0 3px rgba(0,172,65,.12); }

    .filter-row { display:flex; flex-wrap:wrap; gap:.5rem; align-items:flex-end; }
    .filter-group { display:flex; flex-direction:column; gap:.25rem; }
    .filter-group label { font-size:.72rem; font-weight:600; color:var(--muted); text-transform:uppercase; letter-spacing:.05em; white-space:nowrap; }
    select.filter {
      padding:.5rem .7rem; border:1px solid var(--line); border-radius:10px;
      font-family:inherit; font-size:.88rem; color:var(--ink);
      background:#fff; cursor:pointer; min-width:140px;
    }
    select.filter:focus { outline:none; border-color:var(--green); box-shadow:0 0 0 3px rgba(0,172,65,.12); }
    select.filter:disabled { background:#f5f5f5; color:var(--muted); cursor:not-allowed; }

    .filter-divider { width:1px; background:var(--line); height:38px; align-self:flex-end; margin:0 .35rem; }
    .vehicle-badge { font-size:.72rem; font-weight:700; color:var(--green); background:rgba(0,172,65,.08); border:1px solid rgba(0,172,65,.2); border-radius:999px; padding:.15rem .55rem; align-self:flex-end; margin-bottom:.45rem; white-space:nowrap; }

    /* Results header */
    .results-meta { padding:.75rem 0 .5rem; display:flex; align-items:baseline; justify-content:space-between; gap:1rem; flex-wrap:wrap; }
    .results-count { font-size:.88rem; color:var(--muted); }
    .date-note { font-size:.8rem; color:var(--muted); }

    /* Card grid */
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(265px,1fr)); gap:.85rem; padding-bottom:3rem; }
    .card { background:#fff; border:1px solid var(--line); border-radius:14px; padding:1.1rem; display:flex; flex-direction:column; gap:.55rem; transition:box-shadow .25s, transform .25s; }
    .card:hover { box-shadow:0 8px 28px rgba(0,43,16,.09); transform:translateY(-3px); border-color:#b7d9c6; }
    .sku { color:var(--muted); font-size:.75rem; font-weight:700; letter-spacing:.07em; text-transform:uppercase; }
    .card h2 { font-size:1rem; line-height:1.3; font-weight:700; }
    .card h2 a:hover { color:var(--green); }
    .desc { color:var(--muted); font-size:.88rem; line-height:1.5; flex:1; }
    .card-meta { display:flex; flex-wrap:wrap; gap:.4rem; margin-top:.2rem; }
    .pill { background:var(--soft); border:1px solid var(--line); color:var(--deep); font-size:.75rem; font-weight:600; padding:.2rem .6rem; border-radius:999px; }
    .card-link { color:var(--green); font-weight:700; font-size:.88rem; margin-top:.25rem; }
    .card-link:hover { color:var(--deep); }
    .no-results { grid-column:1/-1; text-align:center; padding:3rem 1rem; color:var(--muted); }
    .no-results strong { display:block; font-size:1.1rem; color:var(--ink); margin-bottom:.5rem; }

    /* Footer */
    .site-footer { background:linear-gradient(160deg,#001a0a 0%,#002b10 100%); color:rgba(255,255,255,.55); font-size:.88rem; }
    .footer-inner { padding:2rem 0 1.25rem; display:flex; align-items:flex-start; justify-content:space-between; gap:2rem; flex-wrap:wrap; }
    .footer-brand img { height:30px; filter:brightness(0) invert(1); margin-bottom:.5rem; display:block; }
    .footer-links { display:flex; gap:1.75rem; }
    .footer-links a { color:rgba(255,255,255,.5); transition:color .2s; }
    .footer-links a:hover { color:var(--green); }
    .footer-hr { border:none; border-top:1px solid rgba(255,255,255,.08); }
    .footer-bottom { padding:.85rem 0; display:flex; justify-content:space-between; flex-wrap:wrap; gap:.5rem; color:rgba(255,255,255,.3); font-size:.8rem; }

    @media (max-width:640px) {
      .filter-row { flex-direction:column; align-items:stretch; }
      .filter-divider { width:100%; height:1px; margin:.1rem 0; }
      .vehicle-badge { align-self:flex-start; }
      select.filter { min-width:0; width:100%; }
      .footer-inner { flex-direction:column; gap:1.25rem; }
      .footer-links { flex-wrap:wrap; gap:.85rem; }
    }
  </style>
</head>
<body>

  <nav class="site-nav">
    <div class="wrap nav-row">
      <a class="nav-brand" href="../index.html">
        <img src="../img/logo.png" alt="DisCor">
        <span>Catálogo</span>
      </a>
      <a class="nav-cta" href="https://clientes.discor.com.ar" target="_blank" rel="noopener">Área Clientes</a>
    </div>
  </nav>

  <div class="search-bar">
    <div class="wrap">
      <div class="search-input-wrap">
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" fill="currentColor" viewBox="0 0 16 16"><path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001q.044.06.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1 1 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0"/></svg>
        <input type="search" id="q" placeholder="Buscar por nombre, SKU o marca de repuesto…" autocomplete="off">
      </div>
      <div class="filter-row">
        <div class="filter-group">
          <label>Categoría</label>
          <select class="filter" id="f-cat"><option value="">Todas las categorías</option>${categoryOptions}</select>
        </div>
        <div class="filter-divider" aria-hidden="true"></div>
        <span class="vehicle-badge">🚗 Por vehículo</span>
        <div class="filter-group">
          <label>Marca vehículo</label>
          <select class="filter" id="f-vbrand"><option value="">Todas las marcas</option>${vehicleBrandOptions}</select>
        </div>
        <div class="filter-group">
          <label>Modelo</label>
          <select class="filter" id="f-vmodel" disabled><option value="">Seleccioná marca primero</option></select>
        </div>
        <div class="filter-group">
          <label>Año</label>
          <select class="filter" id="f-vyear" disabled><option value="">Seleccioná modelo primero</option></select>
        </div>
      </div>
    </div>
  </div>

  <main class="wrap">
    <div class="results-meta">
      <span class="results-count" id="results-count">${pages.length} productos</span>
      <span class="date-note">Actualizado el ${escapeHtml(now)}</span>
    </div>
    <section class="grid" id="grid">
${cards}
      <div class="no-results" id="no-results" hidden>
        <strong>Sin resultados</strong>
        Probá con otros términos o borrá los filtros.
      </div>
    </section>
  </main>

  <footer class="site-footer">
    <div class="wrap">
      <div class="footer-inner">
        <div class="footer-brand">
          <img src="../img/logo.png" alt="DisCor">
          <p>Distribuidor mayorista de autopartes y cerrajería en Córdoba.</p>
        </div>
        <nav class="footer-links">
          <a href="../index.html">Inicio</a>
          <a href="https://clientes.discor.com.ar" target="_blank" rel="noopener">Área Clientes</a>
          <a href="https://wa.me/5493517638778" target="_blank" rel="noopener">WhatsApp</a>
          <a href="../terms.html">Términos</a>
        </nav>
      </div>
      <hr class="footer-hr">
      <div class="footer-bottom">
        <span>&copy; <span id="year"></span> DisCor. Todos los derechos reservados.</span>
      </div>
    </div>
  </footer>

  <script>
    document.getElementById('year').textContent = new Date().getFullYear();
    (function () {
      var brandModels = ${brandModelsJson};
      var modelYears  = ${modelYearsJson};

      var cards    = Array.from(document.querySelectorAll('#grid .card'));
      var qInput   = document.getElementById('q');
      var catSel   = document.getElementById('f-cat');
      var vBrandSel= document.getElementById('f-vbrand');
      var vModelSel= document.getElementById('f-vmodel');
      var vYearSel = document.getElementById('f-vyear');
      var countEl  = document.getElementById('results-count');
      var noRes    = document.getElementById('no-results');
      var total    = cards.length;

      function setOptions(sel, opts, placeholder, disabled) {
        sel.innerHTML = '<option value="">' + placeholder + '</option>' +
          opts.map(function (o) { return '<option value="' + o + '">' + o + '</option>'; }).join('');
        sel.disabled = disabled;
        sel.value = '';
      }

      function filter() {
        var q      = qInput.value.toLowerCase().trim();
        var cat    = catSel.value;
        var vBrand = vBrandSel.value;
        var vModel = vModelSel.value;
        var vYear  = parseInt(vYearSel.value) || 0;
        var visible = 0;

        cards.forEach(function (card) {
          var matchQ   = !q || card.dataset.name.includes(q) || card.dataset.sku.includes(q) || card.dataset.brand.toLowerCase().includes(q);
          var matchCat = !cat || card.dataset.category === cat;
          var matchV   = true;

          if (vBrand || vModel || vYear) {
            try {
              var compat = JSON.parse(card.dataset.compat || '[]');
              matchV = compat.length > 0 && compat.some(function (c) {
                return (!vBrand || c.b === vBrand) &&
                       (!vModel || c.m === vModel) &&
                       (!vYear  || (vYear >= c.ys && vYear <= c.ye));
              });
            } catch (e) {
              matchV = false;
            }
          }

          var show = matchQ && matchCat && matchV;
          card.hidden = !show;
          if (show) visible++;
        });

        countEl.textContent = visible + ' de ' + total + ' productos';
        noRes.hidden = visible > 0;
      }

      vBrandSel.addEventListener('change', function () {
        var vb = vBrandSel.value;
        setOptions(vModelSel, vb ? (brandModels[vb] || []) : [], vb ? 'Todos los modelos' : 'Seleccioná marca primero', !vb);
        setOptions(vYearSel,  [], 'Seleccioná modelo primero', true);
        filter();
      });

      vModelSel.addEventListener('change', function () {
        var vb = vBrandSel.value, vm = vModelSel.value;
        var yrs = (vb && vm && modelYears[vb] && modelYears[vb][vm]) ? modelYears[vb][vm] : [];
        setOptions(vYearSel, yrs, vm ? 'Todos los años' : 'Seleccioná modelo primero', !vm);
        filter();
      });

      vYearSel.addEventListener('change', filter);
      qInput.addEventListener('input', filter);
      catSel.addEventListener('change', filter);
    })();
  </script>

</body>
</html>`;
}

function renderSitemapXml(pages, siteUrl) {
  const today = new Date().toISOString().slice(0, 10);
  const staticUrls = [
    { loc: `${siteUrl}/`, lastmod: today },
    { loc: `${siteUrl}/products/`, lastmod: today }
  ];

  const productUrls = pages.map((page) => ({
    loc: `${siteUrl}/products/${page.fileName}`,
    lastmod: page.updatedAt ?? today
  }));

  const allUrls = [...staticUrls, ...productUrls];

  const xmlItems = allUrls
    .map((item) => {
      return [
        "  <url>",
        `    <loc>${escapeXml(item.loc)}</loc>`,
        `    <lastmod>${escapeXml(item.lastmod)}</lastmod>`,
        "  </url>"
      ].join("\n");
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${xmlItems}
</urlset>
`;
}

function renderRobotsTxt(siteUrl) {
  return [
    "User-agent: *",
    "Allow: /",
    "",
    `Sitemap: ${siteUrl}/sitemap.xml`,
    ""
  ].join("\n");
}

function buildSeoDescription(productName, description, sku, category, compatibilities) {
  const seen = new Set();
  const models = [];
  for (const item of compatibilities) {
    if (models.length >= 3) break;
    const vg = item.vehicleGeneration ?? {};
    const vm = vg.vehicleModel ?? {};
    const vb = vm.vehicleBrand ?? {};
    const brandName = pickLocaleText(vb.name, "");
    const modelName = pickLocaleText(vm.name, "");
    const ys = parseYear(vg.yearStart);
    const ye = parseYear(vg.yearEnd);
    if (!modelName) continue;
    const key = `${brandName}|${modelName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const yearStr = ys ? (ye ? ` ${ys}-${ye}` : ` ${ys}`) : "";
    models.push(`${[brandName, modelName].filter(Boolean).join(" ")}${yearStr}`);
  }
  const parts = [];
  if (description && description !== "Sin descripción disponible.") parts.push(description);
  if (models.length > 0) parts.push(`Compatible con ${models.join(", ")}.`);
  parts.push(`SKU ${sku}. Categoría: ${category}. DisCor Mayorista Córdoba.`);
  const full = parts.join(" ");
  return full.length <= 155 ? full : `${full.slice(0, 152)}...`;
}

function buildSeoTitle(productName, compatibilities) {
  const seen = new Set();
  const labels = [];
  for (const item of compatibilities) {
    if (labels.length >= 2) break;
    const vg = item.vehicleGeneration ?? {};
    const vm = vg.vehicleModel ?? {};
    const vb = vm.vehicleBrand ?? {};
    const brandName = pickLocaleText(vb.name, "");
    const modelName = pickLocaleText(vm.name, "");
    const ys = parseYear(vg.yearStart);
    const ye = parseYear(vg.yearEnd);
    if (!modelName || !ys) continue;
    const key = `${brandName}|${modelName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const yearStr = ye ? `${ys}-${ye}` : String(ys);
    labels.push([brandName, modelName, yearStr].filter(Boolean).join(" "));
  }
  if (labels.length === 0) return `${productName} | DisCor Mayorista`;
  const forStr = `para ${labels.join(" y ")}`;
  const full = `${productName} ${forStr} | DisCor Mayorista`;
  if (full.length <= 70) return full;
  const short = `${productName} para ${labels[0]} | DisCor`;
  return short.length <= 70 ? short : `${productName} | DisCor Mayorista`;
}

function buildSeoSlug(productName, sku, compatibilities) {
  const namePart = slugify(productName);
  const skuPart = slugify(sku);
  const seen = new Set();
  const compatParts = [];
  for (const item of compatibilities) {
    if (compatParts.length >= 2) break;
    const vg = item.vehicleGeneration ?? {};
    const vm = vg.vehicleModel ?? {};
    const modelName = pickLocaleText(vm.name, "");
    const ys = parseYear(vg.yearStart);
    const ye = parseYear(vg.yearEnd);
    if (!modelName || !ys) continue;
    if (seen.has(modelName)) continue;
    seen.add(modelName);
    const yearStr = ye ? `${ys}-a-${ye}` : String(ys);
    compatParts.push(slugify(`${modelName}-${yearStr}`));
  }
  return [namePart, ...compatParts, skuPart].filter(Boolean).join("-");
}

function pickLocaleText(value, fallback) {
  if (!value) {
    return fallback;
  }
  if (typeof value === "string") {
    return cleanText(value, fallback);
  }
  if (typeof value === "object") {
    if (value.es) {
      return cleanText(value.es, fallback);
    }
    const firstValue = Object.values(value)[0];
    if (firstValue) {
      return cleanText(firstValue, fallback);
    }
  }
  return fallback;
}

function cleanText(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

function parseYear(value) {
  const year = Number(value);
  if (!Number.isInteger(year) || year < 1900 || year > 2200) {
    return null;
  }
  return year;
}

function parsePositiveInteger(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${fieldName} must be a positive integer.`);
  }
  return parsed;
}

function parseNonNegativeInteger(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--${fieldName} must be a non-negative integer.`);
  }
  return parsed;
}

function renderOptionList(values) {
  return Array.from(values)
    .sort((a, b) => String(a).localeCompare(String(b), "es"))
    .map((value) => {
      const text = String(value);
      return `<option value="${escapeAttr(text)}">${escapeHtml(text)}</option>`;
    })
    .join("\n            ");
}

function renderTemplate(template, data) {
  return Object.entries(data).reduce((acc, [key, value]) => {
    const token = `{{${key}}}`;
    return acc.split(token).join(String(value));
  }, template);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("\n", " ").replaceAll("\r", " ");
}

function safeJsonLd(value) {
  return JSON.stringify(value).replaceAll("</script", "<\\/script");
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function slugify(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function trimTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function resolveAbsoluteUrl(candidate, baseUrl) {
  if (typeof candidate !== "string" || candidate.trim() === "") {
    return `${baseUrl}/img/intro-discor.jpg`;
  }

  const value = candidate.trim();
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }

  if (value.startsWith("/")) {
    return `${baseUrl}${value}`;
  }

  const normalizedPath = value.replace(/^\.?\//, "");
  return `${baseUrl}/${normalizedPath}`;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
