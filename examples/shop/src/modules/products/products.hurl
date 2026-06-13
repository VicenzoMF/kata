# API E2E for the products module — public catalog reads + authenticated create.
#
# Run with the server already listening on :3000:
#   pnpm --filter=shop start    # in another terminal
#   pnpm --filter=shop hurl

# 1. GET /products — the seeded catalog (>= 3 items on a fresh boot).
GET http://localhost:3000/products
HTTP 200
[Asserts]
jsonpath "$" count >= 3

# 2. GET /products/prod-keyboard — a seeded product round-trips.
GET http://localhost:3000/products/prod-keyboard
HTTP 200
[Asserts]
jsonpath "$.id" == "prod-keyboard"
jsonpath "$.name" == "Mechanical Keyboard"
jsonpath "$.priceCents" == 12000
jsonpath "$.stock" == 5

# 3. GET /products?inStock=false — only the out-of-stock monitor.
GET http://localhost:3000/products?inStock=false
HTTP 200
[Asserts]
jsonpath "$" count == 1
jsonpath "$[0].id" == "prod-monitor"
jsonpath "$[0].stock" == 0

# 4. GET /products/{unknown} — unified 404 envelope (ADR-0008).
GET http://localhost:3000/products/does-not-exist
HTTP 404
[Asserts]
jsonpath "$.error" == "not_found"
jsonpath "$.message" exists

# 5. POST /products — no auth header, requireAuth short-circuits with 401.
POST http://localhost:3000/products
Content-Type: application/json
{
  "name": "Webcam",
  "priceCents": 8000,
  "stock": 4
}
HTTP 401
[Asserts]
jsonpath "$.error" == "unauthorized"

# 6. POST /products — authenticated, creates a product with a uuid id.
POST http://localhost:3000/products
Content-Type: application/json
X-User-Id: admin
{
  "name": "Webcam",
  "priceCents": 8000,
  "stock": 4
}
HTTP 200
[Captures]
created_id: jsonpath "$.id"
[Asserts]
jsonpath "$.id" matches "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
jsonpath "$.name" == "Webcam"
jsonpath "$.stock" == 4

# 7. GET /products/{created} — the newly created product is retrievable.
GET http://localhost:3000/products/{{created_id}}
HTTP 200
[Asserts]
jsonpath "$.id" == "{{created_id}}"
jsonpath "$.name" == "Webcam"

# 8. POST /products — authenticated but invalid body, unified 422 envelope.
POST http://localhost:3000/products
Content-Type: application/json
X-User-Id: admin
{
  "name": "",
  "priceCents": -5,
  "stock": 4
}
HTTP 422
[Asserts]
jsonpath "$.error" == "validation_failed"
jsonpath "$.issues.body" count == 2
