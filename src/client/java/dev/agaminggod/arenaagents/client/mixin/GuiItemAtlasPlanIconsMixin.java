package dev.agaminggod.arenaagents.client.mixin;

import dev.agaminggod.arenaagents.client.control.PlanItemIcons;
import net.minecraft.client.gui.render.GuiItemAtlas;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.ModifyArg;

/**
 * The plan window copies item icons out of a private GuiItemAtlas, but vanilla creates the atlas colour texture
 * (the first createTexture call) without USAGE_COPY_SRC, so the copy was refused. PlanItemIcons adds the usage
 * only while it constructs its own atlas.
 */
@Mixin(GuiItemAtlas.class)
abstract class GuiItemAtlasPlanIconsMixin {
	@ModifyArg(method = "<init>", at = @At(value = "INVOKE", ordinal = 0,
			target = "Lcom/mojang/renderpearl/api/device/GpuDevice;createTexture(Ljava/lang/String;ILcom/mojang/renderpearl/api/GpuFormat;IIII)Lcom/mojang/renderpearl/api/textures/GpuTexture;"),
			index = 1)
	private int arenaagents$copySourceIconAtlas(int usage) {
		return PlanItemIcons.iconAtlasUsage(usage);
	}
}
