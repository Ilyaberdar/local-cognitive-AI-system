export function FollowOutputButton({ following, target, onToggle }: {
  following: boolean; target: "console" | "activity"; onToggle: () => void;
}) {
  const label = following ? `Pause ${target} auto-scroll` : `Follow latest ${target} output`;
  return <button type="button" className="workflow-follow-button" aria-label={label} title={label}
    aria-pressed={following} onClick={onToggle}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12m-4-4 4 4 4-4M5 19h14" />
    </svg>
  </button>;
}
