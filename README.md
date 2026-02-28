# Stride - Bootstrap 5 HTML template
A simple but clean Bootstrap 5 HTML template from https://templatedeck.com

## Landing product page generator

Generate a test product page from fixture data:

```bash
node scripts/generate-landing-pages.mjs --output test-product.html
```

Generated output:

- `products/test-product.html`

Inputs used by the generator:

- `templates/product-page.template.html`
- `data/test-product.json`

Generate all product pages from the landing API:

```bash
export LANDING_PAGE_API_BASE_URL="https://api.example.com"
export LANDING_PAGE_TOKEN="your_token"
export SITE_URL="https://discor.com.ar"

node scripts/generate-landing-pages.mjs --source api --api-base-url "$LANDING_PAGE_API_BASE_URL"
```

API mode outputs:

- `products/*.html` (one page per product)
- `products/index.html` (catalog index)
- `sitemap.xml`
- `robots.txt`

## GitHub Actions automation

Workflow file:

- `.github/workflows/generate-landing-pages.yml`

Required repository secrets:

- `LANDING_PAGE_API_BASE_URL`
- `LANDING_PAGE_TOKEN`

Optional repository variables:

- `SITE_URL` (default: `https://discor.com.ar`)
- `LANDING_PAGE_LIMIT` (default: `100`)
