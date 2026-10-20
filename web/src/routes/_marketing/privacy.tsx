import { createFileRoute } from "@tanstack/react-router";
import defaultMdxComponents from "fumadocs-ui/mdx";
import PrivacyContent from "../../../content/legal/privacy.md";
import { frontmatter as privacyFrontmatter } from "../../../content/legal/privacy.md?only=frontmatter";
import { LegalPage } from "@/components/legal-page";
import { buildPageSeo } from "@/lib/seo";

export const Route = createFileRoute("/_marketing/privacy")({
  head: () =>
    buildPageSeo({
      title: privacyFrontmatter.title,
      description: privacyFrontmatter.description,
      path: "/privacy",
      titleSuffix: "OpenSEO",
    }),
  component: Privacy,
});

function Privacy() {
  return (
    <LegalPage
      title={privacyFrontmatter.title}
      description={privacyFrontmatter.description}
    >
      <PrivacyContent components={defaultMdxComponents} />
    </LegalPage>
  );
}
