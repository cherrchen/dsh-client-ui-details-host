# `@dsh-electron/dsh-client-ui-details-host`

English | [中文](README.zh.md)

A standard DSH/Cordis Client plugin that hosts one active details surface in the AppFrame details column. The package is portable `platform:web` UI infrastructure: it has no Electron, Node, or Desktop dependency. The npm scope identifies its publisher, not a runtime requirement.

## Composition

The Host plugin is an empty Loader seat. The Client plugin requires `slots`, `layout`, and `sessions`, and provides `ctx.shellDetails`. Loading the plugin does not occupy `details`; the upstream DetailsPanel remains the winner until `open()` succeeds.

`ctx.shellDetails.open(id)` remains supported. Prefer the v0.2 request form when the surface needs arguments:

```ts
ctx.shellDetails.open({
  surfaceId: 'example.alpha',
  payload: { tab: 'diff' },
})
```

Open validates the surface, creates a surface instance, registers DetailsHost into the single `details` slot at a lower shadowing priority than the upstream occupant, verifies DetailsHost won the cell, commits the instance, and then calls `ctx.layout.openDetails()`. Missing or duplicate surface ids, and takeover conflicts, throw typed errors and roll back so the third column cannot render empty Host state. Switching to another registered id keeps DetailsHost mounted and does not close the column. `close()` is idempotent: it closes the column, clears the active instance, and disposes takeover so the upstream occupant returns.

Public reactive state is available through `getSnapshot()` / `subscribe()` for `useSyncExternalStore`. P0 keeps `canGoBack` false and `historyDepth` at 0. Capability negotiation uses `apiVersion` (2) and `features` (`stateSubscription`, `payloadRouting`, `surfaceInstances`, `conflictDetection`).

Other Client plugins contribute surfaces with declaration-aware injection. The Host routes the active instance through slot owner props:

```ts
ctx.slots.inject('shell.details.surface', () =>
  ctx.slots.register({
    name: 'shell.details.surface',
    id: 'example.alpha',
    label: 'Example Alpha',
  }, ExampleSurface))

// ExampleSurface props include detailsInstance from PropsRuntime<'shell.details.surface'>
```

Optional payload typing uses declaration merging on the Client entry:

```ts
declare module '@dsh-electron/dsh-client-ui-details-host/client' {
  interface DetailsSurfacePayloadMap {
    'example.alpha': { tab?: string }
  }
}
```

Unknown external surfaces and payloads remain supported without augmentation.

This release keeps N registered surfaces and 0 or 1 active surface instance. It does not implement split panes, navigation history, descriptors, header actions, session restore, or persistence. Panel geometry stays with `ctx.layout`.

Unloading the active surface, switching the current session, a surface render crash, or unloading Details Host all close takeover and restore the upstream occupant. After a later reload, `slots.inject()` rematerializes contributions against a new declaration lifetime.

## Development

Use Node.js `^22.19` or `>=24` with pnpm 11. This repository is the canonical source; DeepSeek Harness Desktop mirrors it with git subtree.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm pack --dry-run
```

## Model Experience

None, as this package contributes human-facing Client UI infrastructure without registering model tools or prompt content.

#### KV Cache effect

None. The package does not add, replace, or retain model-request tokens.

## Known Limitations and Deferred Work

- **Single active surface** — only one `shell.details.surface` instance renders at a time; split, stacked, or pinned details columns are not implemented.
- **No navigation history** — P0 snapshot fields `canGoBack` / `historyDepth` are fixed at false / 0 until a later gate.
- **No surface descriptors or header actions** — lifecycle metadata and Host chrome actions arrive in P1.
