import React, { useState } from "react";

export function JsonEditor({ value, onChange }: { value: string; onChange: (next: string) => void }): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <textarea
        value={value}
        rows={8}
        style={{ width: "100%", fontFamily: "JetBrains Mono, monospace" }}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => {
          try {
            JSON.parse(value);
            setError(null);
          } catch {
            setError("Invalid JSON");
          }
        }}
      />
      {error ? <div className="muted">{error}</div> : null}
    </div>
  );
}
