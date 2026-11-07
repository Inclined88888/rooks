import { Select } from "../../ui";
import "./settings.css";

export type Category = { id: string; label: string };

/** The settings categories: a quiet list on the left on a wide screen, a select at the top on a phone. */
export function CategoryNav({ items, value, onChange, label = "Settings" }: { items: Category[]; value: string; onChange: (id: string) => void; label?: string }) {
  return (
    <>
      <nav className="st-nav" aria-label={label}>
        <p className="st-nav-title">{label}</p>
        <ul className="st-nav-list">
          {items.map((c) => (
            <li key={c.id}>
              <button type="button" className={`st-nav-item${c.id === value ? " is-active" : ""}`} aria-current={c.id === value ? "page" : undefined} onClick={() => onChange(c.id)}>
                {c.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="st-nav-phone">
        <Select aria-label={`${label}: section`} value={value} onChange={(e) => onChange(e.target.value)}>
          {items.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </Select>
      </div>
    </>
  );
}
