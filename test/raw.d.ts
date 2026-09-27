// Vite's `?raw` suffix imports a file's text (used to inspect public/assets JS).
declare module "*?raw" {
  const text: string;
  export default text;
}
