/**
 * Bundler-provided module shapes.
 *
 * The client bundle is built by esbuild with `loader: { '.css': 'text' }`, so a stylesheet a dependency ships imports
 * as its own text (the terminal component injects xterm's). TypeScript has no built-in declaration for that.
 */

declare module '*.css' {
  const text: string
  export default text
}
