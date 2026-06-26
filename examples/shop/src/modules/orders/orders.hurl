# API E2E for the orders module — the transactional checkout centerpiece.
#
# Run against a server on {{host}} (default http://localhost:3000):
#   pnpm --filter=shop start    # in another terminal
#   pnpm --filter=shop hurl

# 1. POST /products — seed a dedicated product (stock 3) for this suite.
POST {{host}}/products
Content-Type: application/json
X-User-Id: admin
{
  "name": "Test Widget",
  "priceCents": 1000,
  "stock": 3
}
HTTP 200
[Captures]
widget_id: jsonpath "$.id"

# 2. POST /orders — no auth header, 401.
POST {{host}}/orders
HTTP 401
[Asserts]
jsonpath "$.error" == "unauthorized"

# 3. POST /orders — authenticated but empty cart, 422 cart_empty.
POST {{host}}/orders
X-User-Id: u-order
HTTP 422
[Asserts]
jsonpath "$.error" == "cart_empty"

# 4. Add 2 widgets to the cart.
POST {{host}}/cart/items
Content-Type: application/json
X-User-Id: u-order
{
  "productId": "{{widget_id}}",
  "qty": 2
}
HTTP 200
[Asserts]
jsonpath "$.totalCents" == 2000

# 5. POST /orders — checkout succeeds: 201 Created, paid order. The route declares
#    output { 201: OrderSchema, 409: ErrorBodySchema, 422: ErrorBodySchema } (ADR-0011),
#    so this 201 body is now validated against OrderSchema (previously unvalidated).
POST {{host}}/orders
X-User-Id: u-order
HTTP 201
[Captures]
order_id: jsonpath "$.id"
[Asserts]
jsonpath "$.status" == "paid"
jsonpath "$.userId" == "u-order"
jsonpath "$.totalCents" == 2000
jsonpath "$.lines" count == 1
jsonpath "$.lines[0].qty" == 2

# 6. GET /products/{widget} — stock decremented 3 -> 1 by checkout.
GET {{host}}/products/{{widget_id}}
HTTP 200
[Asserts]
jsonpath "$.stock" == 1

# 7. GET /cart — checkout cleared the cart.
GET {{host}}/cart
X-User-Id: u-order
HTTP 200
[Asserts]
jsonpath "$.lines" count == 0

# 8. GET /orders — the order is listed for its owner.
GET {{host}}/orders
X-User-Id: u-order
HTTP 200
[Asserts]
jsonpath "$" count == 1
jsonpath "$[0].id" == "{{order_id}}"

# 9. GET /orders/{id} — fetch the order by id.
GET {{host}}/orders/{{order_id}}
X-User-Id: u-order
HTTP 200
[Asserts]
jsonpath "$.id" == "{{order_id}}"
jsonpath "$.totalCents" == 2000

# 10. GET /orders/{id} — a different user cannot see it (ownership, 404).
GET {{host}}/orders/{{order_id}}
X-User-Id: someone-else
HTTP 404
[Asserts]
jsonpath "$.error" == "not_found"

# 11. Atomic rollback setup: add 5 widgets, but only 1 remains in stock.
POST {{host}}/cart/items
Content-Type: application/json
X-User-Id: u-order
{
  "productId": "{{widget_id}}",
  "qty": 5
}
HTTP 200

# 12. POST /orders — 409 insufficient_stock; the transaction rolls back.
POST {{host}}/orders
X-User-Id: u-order
HTTP 409
[Asserts]
jsonpath "$.error" == "insufficient_stock"

# 13. GET /products/{widget} — stock UNCHANGED at 1 (rollback proven).
GET {{host}}/products/{{widget_id}}
HTTP 200
[Asserts]
jsonpath "$.stock" == 1

# 14. GET /orders — still exactly one order; the failed checkout persisted nothing.
GET {{host}}/orders
X-User-Id: u-order
HTTP 200
[Asserts]
jsonpath "$" count == 1
