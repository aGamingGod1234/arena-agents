package dev.agaminggod.arenaagents.control;

import dev.agaminggod.arenaagents.agent.AgentValidators;
import java.util.List;
import java.util.Objects;

/**
 * What the coordinator found on this machine for one provider: whether its CLI is installed and signed in, the
 * redacted account and plan, its default and free models, and what kind of usage limit the account has. The models
 * themselves (labels, reasoning levels, speed tiers) are the catalog options. Null fields are unknown.
 */
public record AgentControlProvider(
		String id,
		String label,
		int color,
		Boolean installed,
		String version,
		Boolean signedIn,
		String account,
		String plan,
		String defaultModel,
		List<String> freeModels,
		String limitKind,
		String limit,
		long checkedAt
) {
	public static final int MAX_PROVIDERS = 16;

	public AgentControlProvider {
		id = AgentValidators.requireProvider(id);
		label = bounded(label, "label", 48);
		if (color < 0 || color > 0xFFFFFF) throw new IllegalArgumentException("color must be RGB");
		version = version == null ? null : bounded(version, "version", 48);
		account = account == null ? null : bounded(account, "account", 48);
		plan = plan == null ? null : bounded(plan, "plan", 32);
		defaultModel = defaultModel == null ? null : bounded(defaultModel, "default model", 128);
		freeModels = List.copyOf(freeModels == null ? List.of() : freeModels);
		if (freeModels.size() > AgentControlModelOption.MAX_OPTIONS) throw new IllegalArgumentException("too many free models");
		for (String model : freeModels) bounded(model, "free model", 128);
		limitKind = limitKind == null ? "unknown" : bounded(limitKind, "limit kind", 24);
		limit = limit == null ? null : bounded(limit, "limit", 48);
		if (checkedAt < 0) throw new IllegalArgumentException("checkedAt must not be negative");
	}

	/** Usable here: not known to be missing or signed out. */
	public boolean usable() {
		return !Boolean.FALSE.equals(installed) && !Boolean.FALSE.equals(signedIn);
	}

	private static String bounded(String value, String field, int maximum) {
		String checked = Objects.requireNonNull(value, field + " must not be null").strip();
		if (checked.isEmpty() || checked.length() > maximum || checked.codePoints().anyMatch(Character::isISOControl)) {
			throw new IllegalArgumentException(field + " is invalid");
		}
		return checked;
	}
}
