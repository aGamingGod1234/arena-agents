export const CONTEXT_PRICE_USD = Object.freeze({ input: 2e-6, cacheRead: 0.2e-6, cacheWrite: 8e-6, output: 20e-6 });

/** Rent before buying: fund elective replacement writes from already billed context reads.
 * A replacement's actual first-call write settles its quote. Unexpected write growth becomes
 * debt, so it cannot finance another reset. This bounds overhead; it does not promise neutrality.
 */
export class HandoffBudget {
	#credit = 0;
	#measurement = null;
	#reservation = null;
	#firstPayloadBytes = null;
	#totalRead = 0;
	#totalWrite = 0;
	#lastOverrun = 0;
	#lastElectiveWrite = 0;

	startSession(payloadBytes) {
		this.#firstPayloadBytes = payloadBytes;
		// Forced restarts are not elective purchases; discard their unused positive credit.
		if (this.#reservation === null) this.#credit = Math.min(0, this.#credit);
	}

	noteUsage({ cacheRead = 0, cacheWrite = 0, input = 0 }) {
		if (this.#firstPayloadBytes !== null) {
			const writeUsd = cacheWrite * CONTEXT_PRICE_USD.cacheWrite + input * CONTEXT_PRICE_USD.input;
			this.#measurement = { writeUsd, payloadBytes: this.#firstPayloadBytes };
			this.#firstPayloadBytes = null;
			if (this.#reservation !== null) {
				this.#lastOverrun = Math.max(0, writeUsd - this.#reservation);
				this.#credit -= this.#lastOverrun;
				this.#totalWrite += writeUsd;
				this.#lastElectiveWrite = writeUsd;
				this.#reservation = null;
			}
		}
		const readUsd = cacheRead * CONTEXT_PRICE_USD.cacheRead;
		this.#credit += readUsd;
		this.#totalRead += readUsd;
	}

	quote(payloadBytes) {
		// The previous measured first write includes actual prefix reuse and provider overhead.
		// Charge positive payload growth at one token per UTF-8 byte; do not assume shrinking
		// text or a new process will improve cache reuse. Any remaining miss is settled as debt.
		const estimatedWriteUsd = this.#measurement === null ? Infinity : this.#measurement.writeUsd
			+ Math.max(0, payloadBytes - this.#measurement.payloadBytes) * CONTEXT_PRICE_USD.cacheWrite;
		return { estimatedWriteUsd, creditUsd: this.#credit,
			allowed: this.#reservation === null && this.#credit >= estimatedWriteUsd };
	}

	reserve(payloadBytes) {
		const quote = this.quote(payloadBytes);
		if (!quote.allowed) return false;
		this.#credit = 0;
		this.#reservation = quote.estimatedWriteUsd;
		return true;
	}

	cancelReservation() {
		if (this.#reservation === null) return;
		this.#credit += this.#reservation;
		this.#reservation = null;
	}

	get snapshot() {
		return { creditUsd: this.#credit, totalReadUsd: this.#totalRead, totalElectiveWriteUsd: this.#totalWrite,
			lastWriteUsd: this.#measurement?.writeUsd ?? null, lastPayloadBytes: this.#measurement?.payloadBytes ?? null, lastOverrunUsd: this.#lastOverrun,
			lastElectiveWriteUsd: this.#lastElectiveWrite, reservedWriteUsd: this.#reservation, unsettledDebtUsd: Math.max(0, -this.#credit) };
	}
}
