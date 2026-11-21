import React, { useCallback, useEffect, useRef, useState } from "react";

const trackStyle = {
  display: "flex",
  flexWrap: "nowrap",
  overflowX: "auto",
  whiteSpace: "nowrap",
  gap: "6px",
  WebkitOverflowScrolling: "touch",
  scrollbarWidth: "none",
};

const itemStyle = { flexShrink: 0 };

function SliderTrack({ children, className = "", ariaLabel = "Slider options" }) {
  const trackRef = useRef(null);
  const [hasOverflow, setHasOverflow] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const [canScrollBack, setCanScrollBack] = useState(false);
  const [canScrollForward, setCanScrollForward] = useState(false);

  const updateScrollState = useCallback(() => {
    try {
      const track = trackRef.current;
      if (!track) {
        setHasOverflow(false);
        setCanScrollBack(false);
        setCanScrollForward(false);
        return;
      }

      const maxScroll = Math.max(0, track.scrollWidth - track.clientWidth);
      const currentScroll = Math.max(0, track.scrollLeft || 0);
      setHasOverflow(maxScroll > 0);
      setCanScrollBack(currentScroll > 0);
      setCanScrollForward(currentScroll < maxScroll - 1);
    } catch {
      setHasOverflow(false);
      setCanScrollBack(false);
      setCanScrollForward(false);
    }
  }, []);

  useEffect(() => {
    try {
      const track = trackRef.current;
      if (!track) return undefined;

      updateScrollState();
      let resizeObserver;
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(updateScrollState);
        resizeObserver.observe(track);
        if (track.firstElementChild) resizeObserver.observe(track.firstElementChild);
      }

      let mediaQuery;
      const updateDevice = () => {
        try {
          mediaQuery = window.matchMedia("(hover: hover) and (pointer: fine)");
          setIsDesktop(Boolean(mediaQuery.matches));
        } catch {
          setIsDesktop(false);
        }
      };
      updateDevice();
      if (mediaQuery?.addEventListener) {
        mediaQuery.addEventListener("change", updateDevice);
      } else if (mediaQuery?.addListener) {
        mediaQuery.addListener(updateDevice);
      }

      window.addEventListener("resize", updateScrollState);
      return () => {
        try {
          resizeObserver?.disconnect();
          window.removeEventListener("resize", updateScrollState);
          if (mediaQuery?.removeEventListener) {
            mediaQuery.removeEventListener("change", updateDevice);
          } else if (mediaQuery?.removeListener) {
            mediaQuery.removeListener(updateDevice);
          }
        } catch {
          // Cleanup is best-effort when the DOM is unavailable.
        }
      };
    } catch {
      setHasOverflow(false);
      setIsDesktop(false);
      return undefined;
    }
  }, [children, updateScrollState]);

  const scroll = useCallback((direction) => {
    try {
      const track = trackRef.current;
      if (!track) return;
      const distance = Math.max(0, Math.floor(track.clientWidth * 0.75));
      track.scrollBy({ left: direction * distance, behavior: "smooth" });
    } catch {
      // Ignore unsupported or unavailable DOM scrolling APIs.
    }
  }, []);

  const showControls = isDesktop && hasOverflow;

  return (
    <div className={`slider-controls ${className}`.trim()} style={{ position: "relative", minWidth: 0 }}>
      {showControls && (
        <button
          type="button"
          aria-label="Scroll options left"
          disabled={!canScrollBack}
          onClick={() => scroll(-1)}
          style={{ ...buttonStyle, left: 0 }}
        >
          ‹
        </button>
      )}
      <div
        ref={trackRef}
        className="slider-controls__track"
        role="region"
        aria-label={ariaLabel}
        onScroll={updateScrollState}
        style={trackStyle}
      >
        {React.Children.map(children, (child) =>
          child == null ? null : <div style={itemStyle}>{child}</div>,
        )}
      </div>
      {showControls && (
        <button
          type="button"
          aria-label="Scroll options right"
          disabled={!canScrollForward}
          onClick={() => scroll(1)}
          style={{ ...buttonStyle, right: 0 }}
        >
          ›
        </button>
      )}
    </div>
  );
}

const buttonStyle = {
  alignItems: "center",
  background: "rgba(18, 18, 18, 0.9)",
  border: "1px solid rgba(255, 255, 255, 0.2)",
  borderRadius: "50%",
  color: "#fff",
  cursor: "pointer",
  display: "flex",
  height: "32px",
  justifyContent: "center",
  position: "absolute",
  top: "50%",
  transform: "translateY(-50%)",
  width: "32px",
  zIndex: 1,
};

/** A horizontal strip for selectable options. */
export function HorizontalOptionSlider({
  options = [],
  value,
  onChange,
  renderOption,
  getOptionKey,
  className = "",
  ariaLabel = "Options",
  children,
}) {
  const content = children ?? options.map((option, index) => {
    const key = getOptionKey ? getOptionKey(option, index) : option?.id ?? option?.value ?? index;
    const optionValue = option?.value ?? option;
    const isActive = value === optionValue;
    const label = option?.label ?? option?.name ?? String(optionValue ?? "");

    return renderOption ? (
      <React.Fragment key={key}>{renderOption(option, { isActive, onSelect: () => onChange?.(optionValue) })}</React.Fragment>
    ) : (
      <button
        key={key}
        type="button"
        aria-pressed={isActive}
        onClick={() => onChange?.(optionValue)}
        style={{ ...optionButtonStyle, ...(isActive ? activeOptionStyle : {}) }}
      >
        {label}
      </button>
    );
  });

  return <SliderTrack className={className} ariaLabel={ariaLabel}>{content}</SliderTrack>;
}

/** A compact horizontal slider intended for an app's top header. */
export function TopHeaderSlider({ children, className = "", ariaLabel = "Header navigation" }) {
  return <SliderTrack className={className} ariaLabel={ariaLabel}>{children}</SliderTrack>;
}

/** A horizontal slider for video or media player tools. */
export function PlayerToolsSlider({ children, className = "", ariaLabel = "Player tools" }) {
  return <SliderTrack className={className} ariaLabel={ariaLabel}>{children}</SliderTrack>;
}

const optionButtonStyle = {
  background: "#1c1c1c",
  border: "1px solid #383838",
  borderRadius: "999px",
  color: "#f5f5f5",
  cursor: "pointer",
  padding: "8px 14px",
};

const activeOptionStyle = {
  background: "#fff",
  borderColor: "#fff",
  color: "#111",
};

export default HorizontalOptionSlider;
