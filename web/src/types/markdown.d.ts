declare module "*.md" {
  import type { ComponentType } from "react";

  export const frontmatter: {
    title: string;
    description?: string;
    [key: string]: unknown;
  };

  const MDXContent: ComponentType<{
    components?: Record<string, unknown>;
  }>;

  export default MDXContent;
}

declare module "*.mdx" {
  import type { ComponentType } from "react";

  export const frontmatter: {
    title: string;
    description?: string;
    [key: string]: unknown;
  };

  const MDXContent: ComponentType<{
    components?: Record<string, unknown>;
  }>;

  export default MDXContent;
}

// fumadocs-mdx compiles `?only=frontmatter` imports to just the frontmatter
// export. Route `head` options stay in the entry chunk, so importing the full
// module there would ship every page's compiled body to every visitor.
declare module "*.md?only=frontmatter" {
  export const frontmatter: {
    title: string;
    description?: string;
    [key: string]: unknown;
  };
}

declare module "*.mdx?only=frontmatter" {
  export const frontmatter: {
    title: string;
    description?: string;
    [key: string]: unknown;
  };
}
