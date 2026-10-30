"use client";

import { useEffect, useState } from "react";

export function CurrentYear() {
  const [year, setYear] = useState<number>(2026);

  useEffect(() => {
    setYear(new Date().getFullYear());
  }, []);

  return <span suppressHydrationWarning>{year}</span>;
}
