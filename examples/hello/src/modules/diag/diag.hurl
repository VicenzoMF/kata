# API E2E for the diag module — surfaces the per-request correlation id (#63).
#
# Run with the server already listening on :3000:
#   pnpm --filter=hello start    # in another terminal
#   pnpm --filter=hello hurl

# 1. GET /request-id — no inbound id: the runtime generates a UUID, returns it
#    in the body, and echoes it on the x-request-id response header.
GET http://localhost:3000/request-id
HTTP 200
[Asserts]
header "X-Request-Id" matches "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
jsonpath "$.requestId" matches "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"


# 2. GET /request-id — a well-formed inbound x-request-id is reused end to end:
#    same id on the context (body), on the response header, and in the logs.
GET http://localhost:3000/request-id
X-Request-Id: trace-from-edge-1
HTTP 200
[Asserts]
header "X-Request-Id" == "trace-from-edge-1"
jsonpath "$.requestId" == "trace-from-edge-1"


# 3. GET /export.csv — a non-JSON route: the handler returns `new Response(...)`
#    directly instead of `c.json`. Regression coverage for issue #207: this used
#    to be the one return path that dropped every app-level response header
#    (main.ts's `[cors(), secureHeaders(), bodyLimit()]` chain). The handler's
#    own `content-type` must survive untouched alongside the merged-in headers.
GET http://localhost:3000/export.csv
HTTP 200
[Asserts]
header "Content-Type" == "text/csv; charset=utf-8"
header "Content-Disposition" == "attachment; filename=\"export.csv\""
header "X-Request-Id" matches "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
header "X-Content-Type-Options" == "nosniff"
header "X-Frame-Options" == "SAMEORIGIN"
header "Strict-Transport-Security" == "max-age=15552000; includeSubDomains"
header "Access-Control-Allow-Origin" == "*"
body == "id,name\n1,Ada Lovelace\n2,Grace Hopper\n"


# 4. GET /nope — no route matches at all (issue #209): Hono's default
#    text/plain 404 must not escape — this still comes back as the ADR-0008
#    JSON envelope, carrying the same x-request-id and security headers as
#    every other response, plus a request log line (asserted in unit tests).
GET http://localhost:3000/nope
HTTP 404
[Asserts]
header "Content-Type" contains "application/json"
jsonpath "$.error" == "not_found"
jsonpath "$.message" == "Route not found"
header "X-Request-Id" matches "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
header "X-Content-Type-Options" == "nosniff"


# 5. DELETE /request-id — the path exists (GET-only): a wrong method answers
#    405, not 404, with a correct Allow header naming the registered method.
DELETE http://localhost:3000/request-id
HTTP 405
[Asserts]
header "Allow" == "GET"
jsonpath "$.error" == "method_not_allowed"


# 6. OPTIONS /request-id — a browser CORS preflight. main.ts's global `cors()`
#    (ADR-0012) makes `buildHonoApp` auto-register a synthetic `OPTIONS`
#    responder for every path (ADR-0020, issue #158) — no per-path OPTIONS
#    route to hand-write, and Access-Control-Allow-Methods names the one
#    method this path declares.
OPTIONS http://localhost:3000/request-id
Origin: https://example.com
Access-Control-Request-Method: GET
HTTP 204
[Asserts]
header "Access-Control-Allow-Origin" == "*"
header "Access-Control-Allow-Methods" == "GET"


# 7. GET /boom — a standing, production-reachable crash route (issue #297):
#    the real-HTTP counterpart to error-boundary.test.ts's in-test-file-only
#    route (which never binds a port and so can't be hit from Hurl). This
#    route's sole job is to throw, so Kata's global error boundary catches it
#    and serialises the unified `internal_error` envelope over an actual
#    listening server — see "Testing the error boundary over real HTTP" in
#    cookbook/errors.md for why this trade-off is accepted.
GET http://localhost:3000/boom
HTTP 500
[Asserts]
header "Content-Type" contains "application/json"
jsonpath "$.error" == "internal_error"
jsonpath "$.message" == "Internal server error"
header "X-Request-Id" matches "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
header "X-Content-Type-Options" == "nosniff"
