import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { AppNav } from "@/src/components/AppNav";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock("@/src/components/I18nProvider", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/src/components/ThemeToggle", () => ({
  ThemeToggle: () => <button type="button">theme</button>,
}));

vi.mock("@/src/components/LanguageSwitcher", () => ({
  LanguageSwitcher: () => <button type="button">language</button>,
}));

describe("AppNav mobile more sheet", () => {
  it("returns focus to More after the sheet closes with Escape", async () => {
    // jsdom 31 applies the component's media queries against a fixed 1024px
    // viewport, where `.nav-mobile-more` is display: none (and so neither
    // accessible nor focusable). Apply the mobile rule that shows it.
    const mobile = document.createElement("style");
    mobile.textContent = ".nav-mobile-more { display: flex !important; }";
    document.head.appendChild(mobile);
    onTestFinished(() => mobile.remove());

    render(<AppNav />);

    const more = screen.getByRole("button", { name: "nav.tooltips.more" });
    more.focus();
    fireEvent.click(more);
    expect(screen.getByRole("dialog", { name: "nav.tooltips.more" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "nav.tooltips.more" })).not.toBeInTheDocument();
      expect(more).toHaveFocus();
    });
  });
});
