package dev.agaminggod.arenaagents.agent;

import java.util.Objects;

public final class AgentDomainException extends IllegalArgumentException {
	private final String code;
	private final String causeCode;

	public AgentDomainException(String code, String message) {
		this(code, message, null);
	}

	public AgentDomainException(String code, String message, String causeCode) {
		super(Objects.requireNonNull(message, "message must not be null"));
		if (code == null || code.isBlank() || code.length() > 64) {
			throw new IllegalArgumentException("code must contain at most 64 characters");
		}
		this.code = code;
		this.causeCode = causeCode;
	}

	public String causeCode() { return causeCode; }

	public String code() {
		return code;
	}
}
