declare module "*.eml?raw" {
  const content: string;
  export default content;
}

declare module "*.pdf?inline" {
  const dataUrl: string;
  export default dataUrl;
}

declare module "*?raw" {
  const content: string;
  export default content;
}
