package dev.agaminggod.arenaagents.control;

import dev.agaminggod.arenaagents.agent.AgentValidators;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Optional;

/**
 * The models, reasoning levels and speed tiers the coordinator discovered on this machine. Nothing is bundled:
 * until a catalog arrives (or when no provider CLI is usable) the catalog is empty and menus say so.
 */
public final class AgentControlCatalog {
	private static volatile List<AgentControlModelOption> options = List.of();
	private static volatile List<AgentControlProvider> providerRows = List.of();

	private AgentControlCatalog() {
	}

	public static boolean isEmpty() {
		return options.isEmpty();
	}

	public static List<String> providers() {
		return options.stream().map(AgentControlModelOption::provider).distinct().toList();
	}

	public static List<String> models(String provider) {
		String checked = requireProvider(provider);
		return options.stream().filter(option -> option.provider().equals(checked))
				.map(AgentControlModelOption::model).toList();
	}

	/** The provider CLI's own default model when it names one, otherwise its first model. */
	public static String defaultModel(String provider) {
		String checked = requireProvider(provider);
		List<String> available = models(checked);
		return providerRow(checked).map(AgentControlProvider::defaultModel)
				.filter(available::contains).orElse(available.getFirst());
	}

	/** Menus always open on the lowest thinking depth; efforts are sorted ascending by the option itself. */
	public static String defaultReasoning(String provider, String model) {
		return reasoningEfforts(provider, model).getFirst();
	}

	/** Menus always open on normal speed: the provider's standard tier, otherwise "priority". */
	public static String defaultServiceTier(String provider, String model) {
		List<String> tiers = serviceTiers(provider, model);
		String normal = AgentValidators.defaultServiceTier(provider);
		return tiers.contains(normal) ? normal : tiers.contains("priority") ? "priority" : tiers.getFirst();
	}

	public static String displayName(String provider, String model) {
		return requireOption(provider, model).displayName();
	}

	public static List<String> reasoningEfforts(String provider, String model) {
		return requireOption(provider, model).reasoningEfforts();
	}

	public static List<String> serviceTiers(String provider, String model) {
		List<String> tiers = requireOption(provider, model).serviceTiers();
		return tiers.isEmpty() ? List.of(AgentValidators.defaultServiceTier(provider)) : tiers;
	}

	public static boolean hasSpeedMode(String provider, String model) {
		return requireOption(provider, model).serviceTiers().contains("fast");
	}

	public static String requireProvider(String provider) {
		String checked = Objects.requireNonNull(provider, "provider must not be null").toLowerCase(Locale.ROOT);
		if (!providers().contains(checked)) throw new IllegalArgumentException("Unsupported provider: " + checked);
		return checked;
	}

	public static void installRuntimeCatalog(List<AgentControlModelOption> runtimeOptions) {
		installRuntimeCatalog(runtimeOptions, providerRows);
	}

	public static void installRuntimeCatalog(List<AgentControlModelOption> runtimeOptions, List<AgentControlProvider> rows) {
		List<AgentControlModelOption> checked = List.copyOf(
				Objects.requireNonNull(runtimeOptions, "runtimeOptions must not be null"));
		if (checked.size() > AgentControlModelOption.MAX_OPTIONS) {
			throw new IllegalArgumentException("runtime model catalog has an invalid item count");
		}
		long identities = checked.stream().map(option -> option.provider() + "\u0000" + option.model()).distinct().count();
		if (identities != checked.size()) throw new IllegalArgumentException("runtime model catalog contains duplicates");
		List<AgentControlProvider> checkedRows = List.copyOf(Objects.requireNonNull(rows, "rows must not be null"));
		if (checkedRows.size() > AgentControlProvider.MAX_PROVIDERS) throw new IllegalArgumentException("too many provider rows");
		options = checked;
		providerRows = checkedRows;
	}

	public static void resetRuntimeCatalog() {
		options = List.of();
		providerRows = List.of();
	}

	public static List<AgentControlModelOption> currentOptions() {
		return options;
	}

	/** Every provider the coordinator knows, found or not, for the settings table. */
	public static List<AgentControlProvider> providerRows() {
		return providerRows;
	}

	public static Optional<AgentControlProvider> providerRow(String provider) {
		if (provider == null) return Optional.empty();
		String checked = provider.toLowerCase(Locale.ROOT);
		return providerRows.stream().filter(row -> row.id().equals(checked)).findFirst();
	}

	/** RGB colour for a provider: discovery's colour, else a stable colour derived from the id. */
	public static int providerColor(String provider) {
		if (provider == null || provider.isBlank()) return 0xFFFFFF;
		return providerRow(provider).map(AgentControlProvider::color)
				.orElseGet(() -> 0x808080 | (provider.toLowerCase(Locale.ROOT).hashCode() & 0x7F7F7F));
	}

	public static String providerLabel(String provider) {
		return providerRow(provider).map(AgentControlProvider::label).orElse(provider == null ? "" : provider);
	}

	private static AgentControlModelOption requireOption(String provider, String model) {
		String checkedProvider = requireProvider(provider);
		String checkedModel = Objects.requireNonNull(model, "model must not be null");
		return options.stream()
				.filter(option -> option.provider().equals(checkedProvider) && option.model().equals(checkedModel))
				.findFirst()
				.orElseThrow(() -> new IllegalArgumentException(
						"Unsupported model for " + checkedProvider + ": " + checkedModel));
	}
}
