# API E2E for the users module.
# Mirrors the six smoke paths verified manually at bootstrap.
#
# Run with the server already listening on :3000:
#   pnpm --filter=hello dev    # in another terminal
#   pnpm --filter=hello hurl
#
# CI invokes this in #46 via start-server + wait-on + hurl.

# 1. GET /users/none — unknown id, expect 404 + not_found envelope (ADR-0008).
#    Every kata response — success or error — carries a correlation id (#63).
GET http://localhost:3000/users/none
HTTP 404
[Asserts]
jsonpath "$.error" == "not_found"
jsonpath "$.message" exists
header "X-Request-Id" exists


# 2. POST /users — valid body, capture the created id.
POST http://localhost:3000/users
Content-Type: application/json
{
  "name": "Hurl Tester",
  "email": "hurl@example.com"
}
HTTP 200
[Captures]
created_id: jsonpath "$.id"
[Asserts]
jsonpath "$.id" matches "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
jsonpath "$.name" == "Hurl Tester"
jsonpath "$.email" == "hurl@example.com"


# 3. GET /users/{captured-id} — round-trip the user we just created.
GET http://localhost:3000/users/{{created_id}}
HTTP 200
[Asserts]
jsonpath "$.id" == "{{created_id}}"
jsonpath "$.name" == "Hurl Tester"


# 4. POST /users — invalid body, expect 422 with the normalised issue shape.
POST http://localhost:3000/users
Content-Type: application/json
{
  "name": "",
  "email": "not-an-email"
}
HTTP 422
[Asserts]
jsonpath "$.error" == "validation_failed"
jsonpath "$.message" exists
jsonpath "$.issues.body" count == 2
jsonpath "$.issues.body[0].path" == "name"
jsonpath "$.issues.body[0].code" == "too_small"
jsonpath "$.issues.body[0].message" exists
jsonpath "$.issues.body[1].path" == "email"
jsonpath "$.issues.body[1].code" == "invalid_string"
jsonpath "$.issues.body[1].message" == "Invalid email"


# 5. GET /me — no auth header, middleware short-circuits with 401.
GET http://localhost:3000/me
HTTP 401
[Asserts]
jsonpath "$.error" == "unauthorized"
jsonpath "$.message" exists


# 6. GET /me — with x-user-id header, scoped slot populated by middleware. Also
#    sends an inbound x-request-id; the runtime reuses it and echoes it back (#63).
GET http://localhost:3000/me
X-User-Id: 42
X-Request-Id: e2e-trace-1
HTTP 200
[Asserts]
jsonpath "$.id" == "42"
jsonpath "$.name" == "User-42"
jsonpath "$.email" == "user-42@example.test"
header "X-Request-Id" == "e2e-trace-1"


# 7. GET /boom — handler throws; the global error boundary (#62) returns the
#    unified 500 envelope as JSON, never Hono's default text/HTML 500.
GET http://localhost:3000/boom
HTTP 500
[Asserts]
header "Content-Type" contains "application/json"
jsonpath "$.error" == "internal_error"
jsonpath "$.message" exists
