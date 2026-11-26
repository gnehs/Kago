import { useEffect, useState } from "react";

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** The time in unix seconds, read again every half minute, so that a window sorting things under "Today" does not keep saying that past midnight. */
export function useNow() {
  const [now, setNow] = useState(nowSeconds);
  useEffect(() => {
    const timer = setInterval(() => setNow(nowSeconds()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
