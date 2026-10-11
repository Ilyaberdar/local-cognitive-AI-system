// Pages whose source lives elsewhere in the repository, copied in before every build so there is one
// source: the Synthesis language guide (docs/lc-language.md) and the release notes (CHANGELOG.md).
// The copies are generated (see .gitignore); edit the originals.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(site, '..');
const docs = path.join(site, 'src', 'content', 'docs');

const page = (source, target, frontmatter) => {
	const text = fs.readFileSync(path.join(repo, source), 'utf8')
		// Starlight shows the frontmatter title; the file's own top heading would repeat it.
		.replace(/^# .*\n+/, '')
		// Links to other files of the repository go to GitHub.
		.replace(/\]\((?!https?:|#|mailto:)([^)]+)\)/g, (_, link) => `](https://github.com/Ilyaberdar/local-cognitive-AI-system/blob/main/${path.posix.join(path.posix.dirname(source), link)})`);
	const head = Object.entries(frontmatter).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n');
	fs.mkdirSync(path.dirname(path.join(docs, target)), { recursive: true });
	fs.writeFileSync(path.join(docs, target), `---\n${head}\neditUrl: ${JSON.stringify(`https://github.com/Ilyaberdar/local-cognitive-AI-system/edit/main/${source}`)}\n---\n\n${text}`);
};

page('docs/lc-language.md', 'guides/synthesis-language.md', {
	title: 'Synthesis language',
	description: 'LC Spec (.lcspec) contracts and LC Flow (.lcflow) agent loops: syntax, runtime functions, examples and V1 limits.',
});
page('CHANGELOG.md', 'reference/release-notes.md', {
	title: 'Release notes',
	description: 'What each release of Local Cognitive brings.',
});

// The README's screenshots, for the pages that show them, by lower-case name (a Mac's disk may show
// a file as Chat.png that git calls chat.png).
const screens = path.join(site, 'src', 'assets', 'screens');
fs.mkdirSync(screens, { recursive: true });
for (const file of fs.readdirSync(path.join(repo, 'images')).filter((name) => /\.png$/i.test(name))) {
	fs.copyFileSync(path.join(repo, 'images', file), path.join(screens, file.toLowerCase()));
}
