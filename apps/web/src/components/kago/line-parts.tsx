import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type LinePart = { text: ReactNode; danger?: boolean };

/** The parts of a line of a row, set apart by a dot; the ones that are bad news in the danger colour, so that they are the ones seen. */
export function KagoLineParts({ parts }: { parts: ReadonlyArray<LinePart | null | false | undefined> }) {
  const shown = parts.filter((part): part is LinePart => Boolean(part));
  return (
    <>
      {shown.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? " · " : null}
          <span className={cn(part.danger && "text-danger")}>{part.text}</span>
        </Fragment>
      ))}
    </>
  );
}
