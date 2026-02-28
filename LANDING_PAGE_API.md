# Landing Page API Documentation

## Overview

This API exposes product data for public landing pages with controlled access.
It is designed for static/SSR page generation and **does not expose price or stock**.

## Security and configuration

- Protected with a shared token (`Authorization: Bearer <token>`).
- Token env variable: `LANDING_PAGE_TOKEN`
- Minimum required length: `32` characters.
- Constant-time comparison is used to validate tokens.

Recommended token generation:

```bash
openssl rand -hex 32
```

Example `.env`:

```env
LANDING_PAGE_TOKEN=your_generated_token_here
```

After changing env values, restart API service:

```bash
docker compose restart api
```

## Rate limiting

Both landing endpoints are limited to:

- `30` requests per minute (per IP)

When exceeded:

```json
{
  "message": "Demasiadas solicitudes para el endpoint de landing."
}
```

---

## Endpoints

### 1) List landing products

**GET** `/api/products/landing/pages`

#### Headers

```http
Authorization: Bearer <LANDING_PAGE_TOKEN>
```

#### Query params

- `page` (optional, default `1`) - positive integer
- `limit` (optional, default `50`, max `100`)
- `productId` (optional, UUID)
- `sku` (optional, string up to 120 chars)

> `productId` and `sku` are mutually exclusive (cannot be sent together).

#### Example request

```http
GET /api/products/landing/pages?page=1&limit=20
Authorization: Bearer <LANDING_PAGE_TOKEN>
```

#### 200 response

```json
{
  "data": [
    {
      "id": "b3d9e0f2-9b8f-4f17-b720-ef88a6ee9c39",
      "sku": "ABC-123",
      "erpCode": "P0001",
      "name": { "es": "Amortiguador delantero" },
      "description": { "es": "Descripción comercial" },
      "quantityStep": 1,
      "attributes": { "lado": "izquierdo" },
      "brand": {
        "id": "4dcefd22-5c8c-4b41-9d8d-86e850c28b5f",
        "name": { "es": "Marca X" }
      },
      "category": {
        "id": "35b22b26-b34b-4c1d-81c0-606dc3e93f5e",
        "name": { "es": "Suspensión" }
      },
      "compatibilities": [
        {
          "vehicleGenerationId": "0e604d6f-7d78-4897-8f73-cadf4a5249b7",
          "vehicleLocationId": "2e6ba13d-8398-4105-89d9-4f027f7c7841",
          "vehicleLocation": {
            "id": "2e6ba13d-8398-4105-89d9-4f027f7c7841",
            "name": "Delantero"
          },
          "vehicleGeneration": {
            "id": "0e604d6f-7d78-4897-8f73-cadf4a5249b7",
            "yearStart": 2018,
            "yearEnd": 2022,
            "generationName": "MK2",
            "vehicleModel": {
              "id": "8c9f59db-ecf6-46c8-93cb-a0f57157216d",
              "name": "Modelo Y",
              "vehicleBrand": {
                "id": "0fd12564-c6fb-42e0-b6a9-f7f77f7feef4",
                "name": "Marca Auto"
              }
            }
          }
        }
      ]
    }
  ],
  "pagination": {
    "totalItems": 1,
    "totalPages": 1,
    "currentPage": 1
  }
}
```

#### Error responses

- `400` invalid query params
- `401` missing Bearer token
- `403` invalid token
- `429` rate limit exceeded
- `500` server/internal configuration error

---

### 2) Get landing product by id

**GET** `/api/products/landing/pages/:productId`

#### Headers

```http
Authorization: Bearer <LANDING_PAGE_TOKEN>
```

#### Path params

- `productId` (required, UUID)

#### Example request

```http
GET /api/products/landing/pages/b3d9e0f2-9b8f-4f17-b720-ef88a6ee9c39
Authorization: Bearer <LANDING_PAGE_TOKEN>
```

#### 200 response

Returns the same `LandingProductPage` object described above.

#### Error responses

- `400` invalid `productId`
- `401` missing Bearer token
- `403` invalid token
- `404` product not found
- `429` rate limit exceeded
- `500` server/internal configuration error

---

## Notes for consumers

- Returned products are active (`deletedAt = null`).
- List endpoint ordering: `updatedAt desc`, then `id asc`.
- This contract is intentionally catalog-only (landing-safe fields only).
