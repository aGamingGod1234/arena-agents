package dev.agaminggod.arenaagents.client.compat;

import com.mojang.blaze3d.buffers.GpuBuffer;
import com.mojang.blaze3d.platform.IconSet;
import com.mojang.blaze3d.platform.InputConstants;
import com.mojang.blaze3d.systems.GpuDevice;
import com.mojang.blaze3d.textures.GpuTexture;
import com.mojang.blaze3d.vertex.PoseStack;
import java.io.IOException;
import java.io.InputStream;
import java.util.List;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import net.minecraft.network.protocol.game.ServerboundSignUpdatePacket;
import net.minecraft.server.packs.resources.IoSupplier;
import net.minecraft.world.entity.player.Player;
import org.joml.Quaternionfc;

/** Minecraft 26.2 implementation of {@code McClientCompat}; see the 26.3 one for what each call means. */
public final class McClientCompat {
	private McClientCompat() {
	}

	public static final InputConstants.Type KEYBOARD = InputConstants.Type.KEYSYM;

	public static void rotate(PoseStack pose, Quaternionfc rotation) {
		pose.mulPose(rotation);
	}

	/** Before 26.3 the HUD blinked the hearts while the player's invulnerableTime was positive. */
	public static int damageBlinkTicks(Player player) {
		return player.invulnerableTime;
	}

	public static void setDamageBlinkTicks(Player player, int ticks) {
		player.invulnerableTime = ticks;
	}

	public static BlockPos signPosition(ServerboundSignUpdatePacket packet) {
		return packet.getPos();
	}

	public static boolean signFrontText(ServerboundSignUpdatePacket packet) {
		return packet.isFrontText();
	}

	public static List<String> signLines(ServerboundSignUpdatePacket packet) {
		return java.util.Arrays.asList(packet.getLines());
	}

	public static List<IoSupplier<InputStream>> windowIcons() throws IOException {
		return IconSet.RELEASE.getStandardIcons(Minecraft.getInstance().getVanillaPackResources());
	}

	public static final int TEXTURE_USAGE_COPY_SRC = GpuTexture.USAGE_COPY_SRC;

	public static GpuBuffer createReadbackBuffer(GpuDevice device, String label, long bytes) {
		return device.createBuffer(() -> label, GpuBuffer.USAGE_MAP_READ | GpuBuffer.USAGE_COPY_DST, bytes);
	}

	// Screens and the HUD (26.2 moved the current screen and overlay onto Minecraft.gui).

	public static net.minecraft.client.gui.screens.Screen screen(net.minecraft.client.Minecraft client) {
		return client.screen;
	}

	public static void setScreen(net.minecraft.client.Minecraft client, net.minecraft.client.gui.screens.Screen screen) {
		client.setScreen(screen);
	}

	public static net.minecraft.client.gui.screens.Overlay overlay(net.minecraft.client.Minecraft client) {
		return client.getOverlay();
	}

	/** The action-bar line above the hotbar. */
	public static void overlayMessage(net.minecraft.client.Minecraft client, net.minecraft.network.chat.Component message, boolean animate) {
		client.gui.setOverlayMessage(message, animate);
	}

	public static net.minecraft.client.Camera mainCamera(net.minecraft.client.Minecraft client) {
		return client.gameRenderer.getMainCamera();
	}

	public static net.minecraft.client.renderer.state.GameRenderState gameRenderState(net.minecraft.client.Minecraft client) {
		return client.gameRenderer.getGameRenderState();
	}

	public static net.minecraft.client.renderer.RenderBuffers renderBuffers(net.minecraft.client.Minecraft client) {
		return client.renderBuffers();
	}

	// Plan item icons: a private feature dispatcher and atlas, so the icon pass never consumes or draws game submissions.

	public static net.minecraft.client.renderer.feature.FeatureRenderDispatcher iconFeatures(net.minecraft.client.Minecraft client) {
		var buffers = client.renderBuffers();
		return new net.minecraft.client.renderer.feature.FeatureRenderDispatcher(new net.minecraft.client.renderer.SubmitNodeStorage(),
				client.getModelManager(), buffers.bufferSource(), client.getAtlasManager(), buffers.outlineBufferSource(),
				buffers.crumblingBufferSource(), client.font, gameRenderState(client));
	}

	/** 26.1's atlas submits into the dispatcher's own storage and draws through the game buffer source, as GuiRenderer's does. */
	public static net.minecraft.client.gui.render.GuiItemAtlas iconAtlas(net.minecraft.client.Minecraft client,
			net.minecraft.client.renderer.feature.FeatureRenderDispatcher features, int textureSize, int slotSize) {
		return new net.minecraft.client.gui.render.GuiItemAtlas(features.getSubmitNodeStorage(), features,
				client.renderBuffers().bufferSource(), textureSize, slotSize);
	}

	/** Map a read buffer, hand its bytes to the reader, then unmap it. */
	public static void readMapped(GpuBuffer buffer, java.util.function.Consumer<java.nio.ByteBuffer> reader) {
		try (var mapped = com.mojang.blaze3d.systems.RenderSystem.getDevice().createCommandEncoder().mapBuffer(buffer, true, false)) {
			reader.accept(mapped.data());
		}
	}
}
