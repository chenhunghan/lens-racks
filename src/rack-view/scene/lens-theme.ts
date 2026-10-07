import { Color } from "three";

// The scene takes its colours from the CSS custom properties Lens sets for the active
// theme, the same ones element-components resolve their roles to, so the room sits in
// Lens's own background and highlights with Lens's own accent, light theme or dark.

export interface LensTheme {
  readonly key: string;
  readonly isDark: boolean;
  readonly background: Color; // backgroundSecondary (--grey100)
  readonly surface: Color; // backgroundPrimary (--grey80)
  readonly text: Color; // textDefault (--grey20)
  readonly muted: Color; // textMuted (--grey25)
  readonly primary: Color;
  readonly success: Color;
  readonly warning: Color;
  readonly critical: Color;
  readonly notice: Color;
  readonly css: Readonly<Record<"background" | "surface" | "text" | "muted" | "primary" | "success" | "warning" | "critical" | "notice", string>>;
}

const fallbacks = {
  background: "#1e2124",
  surface: "#262b2f",
  text: "#e5e5e5",
  muted: "#a0a0a0",
  primary: "#3d90ce",
  success: "#48c78e",
  warning: "#ffbd2e",
  critical: "#ce3933",
  notice: "#3d90ce",
};

const variables: Record<keyof typeof fallbacks, string> = {
  background: "--grey100",
  surface: "--grey80",
  text: "--grey20",
  muted: "--grey25",
  primary: "--primary",
  success: "--success",
  warning: "--warning",
  critical: "--critical",
  notice: "--notice",
};

const probe = (() => {
  let element: HTMLSpanElement | undefined;

  // Resolves any CSS colour (var chains, hsl(), color-mix()) through the browser.
  return (value: string) => {
    if (!element) {
      element = document.createElement("span");
      element.style.display = "none";
      document.body.appendChild(element);
    }

    element.style.color = "";
    element.style.color = value;

    return getComputedStyle(element).color;
  };
})();

const toColor = (css: string) => {
  const match = /rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)/.exec(css);

  return match ? new Color().setRGB(+match[1]! / 255, +match[2]! / 255, +match[3]! / 255, "srgb") : new Color(css);
};

export const readLensTheme = (): LensTheme => {
  const styles = getComputedStyle(document.documentElement);
  const css = {} as Record<keyof typeof fallbacks, string>;

  for (const key of Object.keys(fallbacks) as Array<keyof typeof fallbacks>) {
    const raw = styles.getPropertyValue(variables[key]).trim();
    css[key] = raw ? probe(raw) || fallbacks[key] : fallbacks[key];
  }

  const background = toColor(css.background);
  const isDark = background.getHSL({ h: 0, s: 0, l: 0 }).l < 0.45;

  return {
    key: Object.values(css).join("|"),
    isDark,
    background,
    surface: toColor(css.surface),
    text: toColor(css.text),
    muted: toColor(css.muted),
    primary: toColor(css.primary),
    success: toColor(css.success),
    warning: toColor(css.warning),
    critical: toColor(css.critical),
    notice: toColor(css.notice),
    css,
  };
};

// Calls back whenever the theme's colours change: the user switching theme, or Lens
// following the OS between light and dark.
export const watchLensTheme = (onChange: (theme: LensTheme) => void) => {
  let current = readLensTheme();
  const check = () => {
    const next = readLensTheme();

    if (next.key !== current.key) {
      current = next;
      onChange(next);
    }
  };
  const observer = new MutationObserver(check);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
  observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", check);
  const timer = setInterval(check, 2000);

  return {
    current: () => current,
    dispose: () => {
      observer.disconnect();
      media.removeEventListener("change", check);
      clearInterval(timer);
    },
  };
};

// An LED colour of a theme role: the role's hue, pushed into HDR so it blooms.
export const ledOf = (color: Color, intensity = 2.2) => {
  const hsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl);

  return new Color().setHSL(hsl.h, Math.max(0.85, hsl.s), 0.5).multiplyScalar(intensity);
};
