export function Stale(props: { readonly text: string; readonly onDismiss: () => void }) {
  return (
    <div className="stale" role="alert">
      <p>{props.text}</p>
      <p className="stale-note">Nothing was sent. The card shows what it says now.</p>
      <button type="button" className="quiet" onClick={props.onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
