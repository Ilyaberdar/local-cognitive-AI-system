const paths = {
  check: "m5 12 4 4L19 6",
  warning: "M12 8v5m0 3v.01M10.3 3.9 2.5 17.5A1.7 1.7 0 0 0 4 20h16a1.7 1.7 0 0 0 1.5-2.5L13.7 3.9a2 2 0 0 0-3.4 0Z",
  close: "m6 6 12 12M18 6 6 18",
  chevron: "m8 10 4 4 4-4",
  external: "M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5",
  refresh: "M20 7v5h-5M20 12a8 8 0 1 0-2.34 5.66",
  play: "m8 5 11 7-11 7V5Z",
  diagnostics: "M9 5h11M9 12h11M9 19h11M3 5h1M3 12h1M3 19h1",
  plus: "M12 5v14M5 12h14",
  folder: "M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z",
  clock: "M12 8v4l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
};

export function SynthesisIcon({ name }: { name: keyof typeof paths }) {
  return <svg className="synthesis-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
