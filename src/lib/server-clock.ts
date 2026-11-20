/* Running markers are stamped and expired on the server's clock (see `expiredCell`), so a machine whose clock is off
   neither expires a live run nor keeps an abandoned one: MCP reads the server's clock directly, and a browser estimates
   it from the Date header of its API responses. Until a response arrives it reads its own. */

let offset = 0;

/** Longer round trips say little about when the server answered: a response can wait out a frozen or suspended tab. */
const MAX_ROUND_TRIP_MS = 5_000;

/** Learn the server's clock from the Date header of a response to a request sent at `sent`. The header has whole
    seconds, so the midpoint of that second is assumed, and the server is assumed to answer midway through the trip. */
export function observeServerDate(date: string | null | undefined, sent: number, received = Date.now()) {
	const server = date ? Date.parse(date) : NaN;
	const trip = received - sent;
	if (Number.isFinite(server) && trip >= 0 && trip <= MAX_ROUND_TRIP_MS) offset = server + 500 - (sent + received) / 2;
}

/** The server's time, as this browser estimates it. */
export const serverNow = () => Date.now() + offset;
