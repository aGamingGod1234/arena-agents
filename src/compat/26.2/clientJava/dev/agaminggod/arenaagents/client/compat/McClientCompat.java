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
}
