/**
 * A part of a mascot pack (client API 15): a skull, a fur, eyes or an
 * accessory that a plugin adds to the mascot configurator, as data.
 *
 * Declare each part's slug in the manifest (`timon.mascot`, by look field),
 * then register its drawing from the browser half:
 * `ctx.slots.register({ slot: 'mascot.parts', key: 'cap', mascotPart: { type: 'acc', label: 'Cap', svg: '…' } })`.
 * The id an agent's look stores is `<pluginId>:<slug>`. A part that is not
 * declared, or whose data fails a check, is refused when it registers.
 */

/** A name for the pickers: one string, or one per language tag (`{ en: 'Cap', fr: 'Casquette' }`). Up to 40 characters. */
export type MascotPartLabel = string | Readonly<Record<string, string>>;

/** A point of an eye outline, in eye units: the screen is 29 high, an eye about 12; x and y within ±9. */
export type MascotPoint = readonly [number, number];

export type MascotPart =
  | {
    type: 'shape';
    label: MascotPartLabel;
    /**
     * Top width (56–96), bottom width (56–96), height (48–84) and corner
     * radius (4–40) of the skull, in the 100×100 box whose head sits on
     * y = 92. Numbers, not an outline: ears, mask, screen and accessory are
     * placed from them.
     */
    skull: { top: number; bottom: number; height: number; radius: number };
  }
  | {
    type: 'color';
    label: MascotPartLabel;
    /** `#rrggbb`; blended into fur like every dyed colour, so the head stays a plush. */
    hex: string;
  }
  | {
    type: 'eyes';
    label: MascotPartLabel;
    /** The left eye, a closed outline of 3 to 128 points centred on (0, 0). */
    left: readonly MascotPoint[];
    /** The right eye; absent: the left one mirrored. */
    right?: readonly MascotPoint[];
    /** A glyph between the eyes; absent: none. */
    middle?: readonly MascotPoint[];
    /** `false`: drawn or closed eyes, which never blink. Default `true`. */
    blink?: boolean;
  }
  | {
    type: 'acc';
    label: MascotPartLabel;
    /**
     * SVG shapes drawn around (0, 0) in a box of about 32 × 32, without an
     * `<svg>` root, up to 16 KiB and 200 elements. Only `g`, `path`, `rect`,
     * `circle`, `ellipse`, `line`, `polyline` and `polygon`, with geometry and
     * presentation attributes (`fill`, `stroke`, `opacity`, `transform`…). No
     * text, `style`, `class`, `id`, link, `on*` handler or `url(…)`: such a
     * part is refused, never trimmed.
     */
    svg: string;
    /** Degrees the tool is tilted by in the paw, -90 to 90. Default 0. */
    tilt?: number;
  };
