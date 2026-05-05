export function generateRunId(): string {
	return `run_${compactIsoNow()}_${random6()}`;
}

function compactIsoNow(): string {
	return new Date().toISOString().replaceAll(/[-:.]/g, "");
}

function random6(): string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
	const bytes = crypto.getRandomValues(new Uint8Array(6));
	return Array.from(bytes, (n) => alphabet[n % alphabet.length]).join("");
}
