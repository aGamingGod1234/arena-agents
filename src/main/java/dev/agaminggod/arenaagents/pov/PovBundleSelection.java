package dev.agaminggod.arenaagents.pov;

import net.minecraft.core.component.DataComponents;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.component.BundleContents;

/**
 * Vanilla's item stream codec does not carry a bundle's selected entry, so every POV refresh would reset a selection
 * the operator just scrolled to. A refreshed bundle with the same entries keeps the mirror's local selection.
 */
public final class PovBundleSelection {
	private PovBundleSelection() {
	}

	public static ItemStack keep(ItemStack previous, ItemStack incoming) {
		if (previous == null || incoming == null || previous.isEmpty() || incoming.isEmpty()) return incoming;
		BundleContents before = previous.get(DataComponents.BUNDLE_CONTENTS);
		BundleContents after = incoming.get(DataComponents.BUNDLE_CONTENTS);
		if (before == null || after == null || after.getSelectedItemIndex() >= 0) return incoming;
		int selected = before.getSelectedItemIndex();
		if (selected < 0 || selected >= after.size() || !before.items().equals(after.items())) return incoming;
		BundleContents.Mutable kept = after.asMutable();
		kept.toggleSelectedItem(selected);
		ItemStack result = incoming.copy();
		result.set(DataComponents.BUNDLE_CONTENTS, kept.toImmutable());
		return result;
	}
}
