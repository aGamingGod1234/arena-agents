package dev.agaminggod.arenaagents.client.compat;

import com.mojang.blaze3d.platform.IconSet;
import com.mojang.blaze3d.platform.InputConstants;
import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.renderpearl.api.buffers.GpuBuffer;
import com.mojang.renderpearl.api.device.GpuDevice;
import com.mojang.renderpearl.api.textures.GpuTexture;
import java.io.IOException;
import java.io.InputStream;
import java.util.List;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import net.minecraft.network.protocol.game.ServerboundSignUpdatePacket;
import net.minecraft.server.packs.resources.IoSupplier;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.block.entity.SignTextSlot;
import org.joml.Quaternionfc;

/** Minecraft 26.3 implementation of the client-side API calls that differ between the 26.x drops (see McCompat). */
public final class McClientCompat {
	private McClientCompat() {
	}

	/** The key type of a keyboard key mapping. */
	public static final InputConstants.Type KEYBOARD = InputConstants.Type.KEYBOARD;

	public static void rotate(PoseStack pose, Quaternionfc rotation) {
		pose.rotate(rotation);
	}

	/** Ticks the HUD still blinks the hearts after a hit. */
	public static int damageBlinkTicks(Player player) {
		return player.damageCooldownTime;
	}

	public static void setDamageBlinkTicks(Player player, int ticks) {
		player.damageCooldownTime = ticks;
	}

	public static BlockPos signPosition(ServerboundSignUpdatePacket packet) {
		return packet.pos();
	}

	public static boolean signFrontText(ServerboundSignUpdatePacket packet) {
		return packet.slot() == SignTextSlot.FRONT;
	}

	public static List<String> signLines(ServerboundSignUpdatePacket packet) {
		return packet.lines();
	}

	/** Vanilla's window icons from the built-in resources. */
	public static List<IoSupplier<InputStream>> windowIcons() throws IOException {
		return IconSet.RELEASE.getStandardIcons(Minecraft.getInstance().getVanillaPackResources().fullResources());
	}

	public static final int TEXTURE_USAGE_COPY_SRC = GpuTexture.USAGE_COPY_SRC;

	/** A buffer the GPU copies a texture region into and the CPU then maps for reading. */
	public static GpuBuffer createReadbackBuffer(GpuDevice device, String label, long bytes) {
		return device.createBuffer(() -> label, GpuBuffer.USAGE_MAP_READ | GpuBuffer.USAGE_COPY_DST, bytes);
	}

	// Screens and the HUD (26.2 moved the current screen and overlay onto Minecraft.gui).

	public static net.minecraft.client.gui.screens.Screen screen(net.minecraft.client.Minecraft client) {
		return client.gui.screen();
	}

	public static void setScreen(net.minecraft.client.Minecraft client, net.minecraft.client.gui.screens.Screen screen) {
		client.gui.setScreen(screen);
	}

	public static net.minecraft.client.gui.screens.Overlay overlay(net.minecraft.client.Minecraft client) {
		return client.gui.overlay();
	}

	/** The action-bar line above the hotbar. */
	public static void overlayMessage(net.minecraft.client.Minecraft client, net.minecraft.network.chat.Component message, boolean animate) {
		client.gui.hud.setOverlayMessage(message, animate);
	}

	public static net.minecraft.client.Camera mainCamera(net.minecraft.client.Minecraft client) {
		return client.gameRenderer.mainCamera();
	}

	public static net.minecraft.client.renderer.state.GameRenderState gameRenderState(net.minecraft.client.Minecraft client) {
		return client.gameRenderer.gameRenderState();
	}

	public static net.minecraft.client.renderer.RenderBuffers renderBuffers(net.minecraft.client.Minecraft client) {
		return client.gameRenderer.renderBuffers();
	}

	// Plan item icons: a private feature dispatcher and atlas, so the icon pass never consumes or draws game submissions.

	public static net.minecraft.client.renderer.feature.FeatureRenderDispatcher iconFeatures(net.minecraft.client.Minecraft client) {
		return new net.minecraft.client.renderer.feature.FeatureRenderDispatcher(renderBuffers(client), client.getModelManager(),
				client.getAtlasManager(), client.font, gameRenderState(client));
	}

	public static net.minecraft.client.gui.render.GuiItemAtlas iconAtlas(net.minecraft.client.Minecraft client,
			net.minecraft.client.renderer.feature.FeatureRenderDispatcher features, int textureSize, int slotSize) {
		return new net.minecraft.client.gui.render.GuiItemAtlas(features, textureSize, slotSize);
	}

	/** Map a read buffer, hand its bytes to the reader, then unmap it. */
	public static void readMapped(GpuBuffer buffer, java.util.function.Consumer<java.nio.ByteBuffer> reader) {
		try (var mapped = buffer.map(true, false)) {
			reader.accept(mapped.data());
		}
	}
}
