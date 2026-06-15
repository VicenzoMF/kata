# API E2E for the users module.
# Covers users CRUD + validation, the real-JWT auth flow on /me (mint → call →
# 401 paths), and the global error boundary.
#
# Run with the server already listening on :3000:
#   pnpm --filter=hello dev    # in another terminal
#   pnpm --filter=hello hurl
#
# CI invokes this in #46 via start-server + wait-on + hurl.

# 1. GET /users/none — unknown id, expect 404 + not_found envelope (ADR-0008).
#    The route declares output { 200: UserSchema, 404: ErrorBodySchema } (ADR-0011),
#    so this 404 body is validated against ErrorBodySchema, not just hand-rolled.
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


# 5. POST /auth/token — mint a real JWT and capture it for the calls below. Stands
#    in for a login/exchange endpoint (it signs the identity it is given) so the
#    suite needs no external tooling. Signed with the dev-default JWT_SECRET, which
#    the verifying middleware shares.
POST http://localhost:3000/auth/token
Content-Type: application/json
{
  "id": "42",
  "name": "Ada",
  "email": "ada@example.com"
}
HTTP 200
[Captures]
token: jsonpath "$.token"
[Asserts]
jsonpath "$.token" exists


# 6. GET /me — no Authorization header, jwtAuth short-circuits with 401 (ADR-0008).
GET http://localhost:3000/me
HTTP 401
[Asserts]
jsonpath "$.error" == "unauthorized"
jsonpath "$.message" == "Missing bearer token"


# 7. GET /me — with the captured Bearer token, the scoped slot is populated by
#    jwtAuth's resolve() hook (claims → User). Also sends an inbound x-request-id;
#    the runtime reuses it and echoes it back (#63).
GET http://localhost:3000/me
Authorization: Bearer {{token}}
X-Request-Id: e2e-trace-1
HTTP 200
[Asserts]
jsonpath "$.id" == "42"
jsonpath "$.name" == "Ada"
jsonpath "$.email" == "ada@example.com"
header "X-Request-Id" == "e2e-trace-1"


# 8. GET /me — a garbage (non-JWT) bearer token → the generic 401. Invalid and
#    expired collapse to one message, so the endpoint is never a validity oracle.
GET http://localhost:3000/me
Authorization: Bearer not-a-real-jwt
HTTP 401
[Asserts]
jsonpath "$.error" == "unauthorized"
jsonpath "$.message" == "Invalid or expired token"


# 9. GET /boom — handler throws; the global error boundary (#62) returns the
#    unified 500 envelope as JSON, never Hono's default text/HTML 500.
GET http://localhost:3000/boom
HTTP 500
[Asserts]
header "Content-Type" contains "application/json"
jsonpath "$.error" == "internal_error"
jsonpath "$.message" exists
