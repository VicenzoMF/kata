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
