/**
 * Hand-written declarations for the two DeepSeek Harness surfaces this plugin stands on.
 *
 * Deliberately not `@deepseek-ai/dsh-*` types: this package promises to keep running across DSH releases, and
 * importing the host's own type packages would tie those releases together. What is written here is the minimum
 * every version has had to offer so far — a Host half registering HTTP routes, and a Client half drawing into the
 * slots the shell exposes. Treat it as documentation that happens to type-check, and widen it only when the plugin
 * actually starts calling something new.
 *
 * Global `DSH` namespace, so JSDoc can say `{DSH.HostPluginContext}` without an import in an ESM `.js` file.
 */

declare namespace DSH {
  /** An unsubscribe/dispose function returned by a registration. */
  type Disposable = () => void

  interface Logger {
    debug(message: string, ...args: unknown[]): void
    info(message: string, ...args: unknown[]): void
    warn(message: string, ...args: unknown[]): void
    error(message: string, ...args: unknown[]): void
  }

  /** Node's `IncomingMessage`, kept structural so these declarations need no `@types/node`. */
  interface HttpRequest {
    method?: string
    url?: string
    headers: Record<string, string | string[] | undefined>
    on(event: string, listener: (...args: unknown[]) => void): unknown
  }

  /** Node's `ServerResponse`, kept structural for the same reason. */
  interface HttpResponse {
    statusCode: number
    headersSent: boolean
    setHeader(name: string, value: string | number | readonly string[]): void
    writeHead(status: number, headers?: Record<string, string | number>): void
    write(chunk: string | Uint8Array): boolean
    end(chunk?: string | Uint8Array): void
    on(event: string, listener: (...args: unknown[]) => void): unknown
  }

  interface WebRoute {
    /** `'GET'` by default. The Host matches method and path before calling the handler. */
    method?: string | string[]
    /** Exact path, e.g. `/superagent/api/engine/status`. */
    path: string
    /** Extra route metadata the Host forwards to its own middleware, when it supports any. */
    [extra: string]: unknown
    handler(request: HttpRequest, response: HttpResponse): void | Promise<void>
  }

  interface WebServerService {
    register(route: WebRoute): Disposable
  }

  interface LocaleService {
    /** `namespace` is the id given to `dsh.client`/`LOCALE_NS`; `dict` may be nested. */
    register(namespace: string, language: string, dict: Record<string, unknown>): Disposable | void
  }

  /** One entry the shell renders in a named slot. */
  interface SlotEntry {
    /** The slot name, e.g. `sidebar.panellist` or `main`. */
    name: string
    /** Stable id inside the slot; `key` is the keyed-slot variant. */
    id?: string
    key?: string
    order?: number
    locale?: string
    /** Sidebar text. The shell accepts either a string or a thunk resolved at render time. */
    label?: string | (() => string)
    icon?: unknown
    [extra: string]: unknown
  }

  interface SlotsService {
    /** Run `callback` once the slot exists, re-running it when the slot list changes. */
    inject(slotName: string, callback: () => void): Disposable
    register(entry: SlotEntry, component: unknown): Disposable
  }

  interface WorkspaceService {
    openSession(id: string): void
  }

  /** The Host half: `apply(ctx)` in `index.js`. */
  interface HostPluginContext {
    logger: Logger
    webServer: WebServerService
    /** Rounds up a cleanup with this plugin's lifetime. */
    effect(callback: () => void | Disposable): void
    /** Resolves another Host service, or `undefined` when it is not present in this build. */
    get<T = unknown>(name: string): T | undefined
    [extra: string]: unknown
  }

  /** Config object from the profile's `plugins` entry; every field is optional. */
  interface PluginConfig {
    /** Overrides `DSH_SUPERAGENT_STATE_DIR`, then `$DSH_HOME/superagent`. `~` is expanded. */
    stateDir?: string
  }

  /** The Client half: `apply(ctx)` in `client/src/apply.js`. */
  interface ClientPluginContext {
    logger?: Logger
    slots: SlotsService
    /** The Client resolves services by name too: `locale`, `uiWorkspace`, … */
    get<T = unknown>(name: string): T | undefined
    [extra: string]: unknown
  }

  interface ClientSlotProps {
    /** Registration id that produced this mount, for components that need it. */
    id?: string
    [extra: string]: unknown
  }
}

interface Window {
  /**
   * The lazy-CJS loader the Client half must register with — see `scripts/build-client.mjs`. Evaluating the bundle
   * only registers `factory`; every side effect runs when the shell materialises the plugin.
   */
  __ModuleLoader__?: {
    load(definition: { id: string; factory(require: (id: string) => unknown): unknown }): void
  }
}

/**
 * The client is compiled with `jsx: 'transform'` + `jsxFactory: 'h'`, so JSX here is classic-runtime syntax and TS
 * looks up the same global namespace. Minimal declarations only: `key` is a framework attribute (never a component
 * prop), and `Element` is whatever the factory returned, which for this codebase is always `any`.
 */
declare namespace JSX {
  type Element = any
  interface IntrinsicAttributes {
    key?: any
  }
  /** The factory receives the tag name as a plain string, so intrinsic elements are untyped props by design. */
  interface IntrinsicElements {
    [tagName: string]: any
  }
  interface ElementChildrenAttribute {
    children: {}
  }
}
