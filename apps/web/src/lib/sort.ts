/** A shared collator sorts a folder of tens of thousands of names far faster than localeCompare does. */
export const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
