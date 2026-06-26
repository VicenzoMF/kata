# API E2E for the cart module — every route requires auth (requireAuth reused).
#
# Run with the server already listening on :3000:
#   pnpm --filter=shop start    # in another terminal
#   pnpm --filter=shop hurl

# 1. GET /cart — no auth header, 401.
GET {{host}}/cart
HTTP 401
[Asserts]
jsonpath "$.error" == "unauthorized"

# 2. GET /cart — authenticated, empty cart for a fresh user.
GET {{host}}/cart
X-User-Id: u-cart
HTTP 200
[Asserts]
jsonpath "$.userId" == "u-cart"
jsonpath "$.lines" count == 0
jsonpath "$.totalCents" == 0

# 3. POST /cart/items — add 2 of the seeded mouse; price snapshotted, total computed.
POST {{host}}/cart/items
Content-Type: application/json
X-User-Id: u-cart
{
  "productId": "prod-mouse",
  "qty": 2
}
HTTP 200
[Asserts]
jsonpath "$.lines" count == 1
jsonpath "$.lines[0].productId" == "prod-mouse"
jsonpath "$.lines[0].unitPriceCents" == 4500
jsonpath "$.lines[0].qty" == 2
jsonpath "$.totalCents" == 9000

# 4. POST /cart/items — same product again merges quantity.
POST {{host}}/cart/items
Content-Type: application/json
X-User-Id: u-cart
{
  "productId": "prod-mouse",
  "qty": 1
}
HTTP 200
[Asserts]
jsonpath "$.lines" count == 1
jsonpath "$.lines[0].qty" == 3
jsonpath "$.totalCents" == 13500

# 5. POST /cart/items — unknown product, 404.
POST {{host}}/cart/items
Content-Type: application/json
X-User-Id: u-cart
{
  "productId": "nope",
  "qty": 1
}
HTTP 404
[Asserts]
jsonpath "$.error" == "product_not_found"

# 6. POST /cart/items — invalid body (qty must be positive), unified 422.
POST {{host}}/cart/items
Content-Type: application/json
X-User-Id: u-cart
{
  "productId": "prod-mouse",
  "qty": 0
}
HTTP 422
[Asserts]
jsonpath "$.error" == "validation_failed"
jsonpath "$.issues.body[0].path" == "qty"

# 7. POST /cart/items — add a second, distinct line. With only one line a delete
#    can't tell "removed that line" from "wiped the whole cart"; two lines makes
#    the next step prove it removed exactly one.
POST {{host}}/cart/items
Content-Type: application/json
X-User-Id: u-cart
{
  "productId": "prod-keyboard",
  "qty": 1
}
HTTP 200
[Asserts]
jsonpath "$.lines" count == 2
jsonpath "$.totalCents" == 25500

# 8. DELETE /cart/items/prod-mouse — removes only the mouse line; the keyboard
#    line must survive (count == 1, not a wiped cart) with the correct remainder.
DELETE {{host}}/cart/items/prod-mouse
X-User-Id: u-cart
HTTP 200
[Asserts]
jsonpath "$.lines" count == 1
jsonpath "$.lines[0].productId" == "prod-keyboard"
jsonpath "$.lines[0].qty" == 1
jsonpath "$.totalCents" == 12000
