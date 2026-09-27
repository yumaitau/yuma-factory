// Wrangler loads these scripts as text for execution inside the container.
declare module "*.mjs" {
  const source: string;
  export default source;
}
