import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import LiquidGlass from "liquid-glass-react";

const mounted = new WeakMap();

/**
 * The LiquidGlass library always applies:
 *   position: style.position || "relative"
 *   top:      style.top      || "50%"
 *   left:     style.left     || "50%"
 *   transform: translate(-50%,-50%) + elasticity
 *
 * So we MUST pass explicit top/left (the pill's center in the viewport)
 * and use position:"fixed" so the glass floats exactly over the pill.
 * We track the pill's rect with ResizeObserver + scroll so it stays locked.
 */
function PlayerGlassOverlay({ pillEl }) {
  const [rect, setRect] = useState(null);

  useEffect(() => {
    if (!pillEl) return;

    function update() {
      const r = pillEl.getBoundingClientRect();
      setRect({ top: r.top + r.height / 2, left: r.left + r.width / 2, width: r.width, height: r.height });
    }

    update();
    const ro = new ResizeObserver(update);
    ro.observe(pillEl);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [pillEl]);

  if (!rect) return null;

  return (
    <LiquidGlass
      displacementScale={58}
      blurAmount={0.08}
      saturation={155}
      aberrationIntensity={1.8}
      elasticity={0.18}
      cornerRadius={22}
      padding="0"
      mode="standard"
      style={{
        position: "fixed",
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        pointerEvents: "none",
        zIndex: 999,          /* just below pill content (z-index 1000) */
      }}
    >
      {/* Empty — the glass is purely decorative, pill content sits above */}
      <span style={{ display: "block", width: "100%", height: "100%" }} aria-hidden="true" />
    </LiquidGlass>
  );
}

export function mountLiquidGlassIslands() {
  const pill = document.querySelector("#playerPill");
  if (!pill || mounted.has(pill)) return;

  // Mount the React root into a fixed-position portal outside the pill DOM
  const host = document.createElement("div");
  host.id = "liquid-glass-portal";
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:999;";
  document.body.appendChild(host);

  const root = createRoot(host);
  root.render(<PlayerGlassOverlay pillEl={pill} />);
  mounted.set(pill, root);
}
