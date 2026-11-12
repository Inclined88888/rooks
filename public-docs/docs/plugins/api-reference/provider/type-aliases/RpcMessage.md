
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: RpcMessage

> **RpcMessage** = \{ `id`: [`RpcId`](RpcId.md); `kind`: `"request"`; `method`: `string`; `params`: `unknown`; \} \| \{ `kind`: `"notification"`; `method`: `string`; `params`: `unknown`; \} \| \{ `id`: [`RpcId`](RpcId.md); `kind`: `"result"`; `result`: `unknown`; \} \| \{ `code`: `number`; `data?`: `unknown`; `id`: [`RpcId`](RpcId.md); `kind`: `"error"`; `message`: `string`; \}

## Union Members

### Type Literal

\{ `id`: [`RpcId`](RpcId.md); `kind`: `"request"`; `method`: `string`; `params`: `unknown`; \}

The agent asks us something and waits for `encodeRpcResult` / `encodeRpcError`.

***

### Type Literal

\{ `kind`: `"notification"`; `method`: `string`; `params`: `unknown`; \}

The agent tells us something (`session/update`); no answer.

***

### Type Literal

\{ `id`: [`RpcId`](RpcId.md); `kind`: `"result"`; `result`: `unknown`; \}

The agent answers one of our requests.

***

### Type Literal

\{ `code`: `number`; `data?`: `unknown`; `id`: [`RpcId`](RpcId.md); `kind`: `"error"`; `message`: `string`; \}

The agent refuses one of our requests.
