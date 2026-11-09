"use client";

import type { ReactNode } from "react";

/** Submit button that asks for confirmation first. The only client component on the operator action forms. */
export function ConfirmButton({ message, className, children, name, value }: { message: string; className: string; children: ReactNode; name?: string; value?: string }) {
  return (
    <button
      type="submit"
      name={name}
      value={value}
      className={className}
      onClick={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
