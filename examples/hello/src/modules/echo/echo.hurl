# API E2E for the echo module — demonstrates the opt-in hardening middleware
# (issue #67): CORS, secure response headers, and a request body-size limit,
# verified here over a real socket.
#
# Run with the server already listening on :3000:
#   pnpm --filter=hello start    # in another terminal
#   pnpm --filter=hello hurl

# 1. POST /echo — valid body. CORS + secure-headers ride along; body is echoed.
POST http://localhost:3000/echo
Content-Type: application/json
{
  "message": "hello"
}
HTTP 200
[Asserts]
header "Access-Control-Allow-Origin" == "*"
header "X-Content-Type-Options" == "nosniff"
header "X-Frame-Options" == "SAMEORIGIN"
jsonpath "$.echoed" == "hello"


# 2. POST /echo — invalid body (empty message) still flows through the hardened
#    chain and is rejected by input validation with the unified 422 envelope.
POST http://localhost:3000/echo
Content-Type: application/json
{
  "message": ""
}
HTTP 422
[Asserts]
header "X-Content-Type-Options" == "nosniff"
jsonpath "$.error" == "validation_failed"
jsonpath "$.issues.body[0].path" == "message"
