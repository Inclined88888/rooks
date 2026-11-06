'use client';

import { useEffect, useState } from 'react';

/** True on a touch-first device, where the soft keyboard lacks Esc, Ctrl and the arrows. */
export function useTouchKeyboard(): boolean {
  const [touch, setTouch] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(pointer: coarse)');
    const read = () => setTouch(query.matches);
    read();
    query.addEventListener('change', read);
    return () => query.removeEventListener('change', read);
  }, []);
  return touch;
}
