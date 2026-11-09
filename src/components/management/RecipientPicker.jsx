import { useEffect, useState } from "react";
import { Plus, Search, TriangleAlert, Users, X } from "lucide-react";
import { useWorkspace } from "../../hooks/useWorkspace";
import { api } from "../../services/api";
import { addRecipient, removeRecipient } from "../../utils/notificationRules";
import { Spinner } from "../common/Spinner";

const recipientLabel = (recipient) =>
  recipient.name || (recipient.type === "finance_admins" ? "All Finance administrators" : recipient.type === "employee_manager" ? "Employee's manager" : "Person");

// Chosen recipients, plus the ways to add one. Choosing a person only records their
// id: the server checks it and supplies their details.
export function RecipientPicker({ label, recipients, onChange, recipientTypes, disabled = false, describedBy, idPrefix }) {
  const { notify } = useWorkspace();
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState([]);
  const [searching, setSearching] = useState(false);
  const managers = recipientTypes.find((type) => type.id === "employee_manager");
  const financeChosen = recipients.some((recipient) => recipient.type === "finance_admins");

  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) {
      setPeople([]);
      setSearching(false);
      return undefined;
    }
    let active = true;
    setSearching(true);
    const timer = setTimeout(() => {
      api.searchDirectory(text).then(
        (result) => active && setPeople(result.people),
        (error) => active && notify(error.message, true),
      ).finally(() => active && setSearching(false));
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, notify]);

  return (
    <fieldset className="recipient-picker" disabled={disabled} aria-describedby={describedBy}>
      <legend>{label}</legend>
      {recipients.length ? (
        <ul className="recipient-chips" aria-label={`Selected: ${label}`}>
          {recipients.map((recipient) => (
            <li key={`${recipient.type}-${recipient.userId ?? ""}`} className={recipient.resolvable === false ? "unresolved" : ""}>
              {recipient.resolvable === false && <TriangleAlert size={14} aria-hidden="true" />}
              <span>
                {recipientLabel(recipient)}
                {recipient.resolvable === false && <small> · can’t be reached</small>}
              </span>
              <button type="button" className="icon-button" aria-label={`Remove ${recipientLabel(recipient)}`} onClick={() => onChange(removeRecipient(recipients, recipient))}>
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted recipient-empty">No recipients yet.</p>
      )}
      <div className="recipient-add">
        <button
          type="button"
          className="button"
          disabled={financeChosen}
          onClick={() => onChange(addRecipient(recipients, { type: "finance_admins", name: "All Finance administrators", resolvable: true }))}
        >
          <Users size={16} aria-hidden="true" />
          {financeChosen ? "Finance administrators added" : "Add all Finance administrators"}
        </button>
        {managers && !managers.available && (
          <p className="recipient-unavailable">
            <button type="button" className="button" disabled>
              Employee’s manager
            </button>
            <small>{managers.unavailableReason}</small>
          </p>
        )}
      </div>
      <label className="field" htmlFor={`${idPrefix}-person`}>
        Add a specific person
      </label>
      <div className="search recipient-search">
        <Search size={16} aria-hidden="true" />
        <input
          id={`${idPrefix}-person`}
          type="search"
          value={query}
          placeholder="Search by name, email or department"
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
        />
        {searching && <Spinner />}
      </div>
      {query.trim().length >= 2 && !searching && !people.length && (
        <p className="muted recipient-empty">Nobody found. People appear here after they sign in to ReceiptFlow once.</p>
      )}
      {people.length > 0 && (
        <ul className="recipient-results">
          {people.map((person) => {
            const added = recipients.some((recipient) => recipient.type === "user" && recipient.userId === person.id);
            return (
              <li key={person.id}>
                <span>
                  <strong>{person.name}</strong>
                  <small>{[person.email, person.department].filter(Boolean).join(" · ")}</small>
                </span>
                <button
                  type="button"
                  className="button"
                  disabled={added}
                  aria-label={added ? `${person.name} added` : `Add ${person.name}`}
                  onClick={() => {
                    onChange(addRecipient(recipients, { type: "user", userId: person.id, name: person.name, resolvable: true }));
                    setQuery("");
                  }}
                >
                  {added ? "Added" : <Plus size={15} aria-hidden="true" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </fieldset>
  );
}
