export type ArchitectureSignalKind =
	| "changed-file"
	| "related-file"
	| "test-file"
	| "import-hint";

export type ArchitectureSignal = {
	kind: ArchitectureSignalKind;
	path: string;
	reason: string;
	source: "git" | "filesystem";
	relatedTo?: string;
};
