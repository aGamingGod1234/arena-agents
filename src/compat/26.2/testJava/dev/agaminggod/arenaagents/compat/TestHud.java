package dev.agaminggod.arenaagents.compat;

import java.util.function.Supplier;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Gui;
import net.minecraft.network.chat.Component;

/** A headless HUD that records the last action-bar message, installed into an allocated Minecraft (26.2). */
public final class TestHud {
	private TestHud() {
	}

	private static final class HeadlessGui extends Gui {
		private HeadlessGui() { super(null, null, null); }
	}

	/** 26.3 moved the overlay message from Gui to its Hud. */
	private static final class HeadlessHud extends net.minecraft.client.gui.Hud {
		private String message = "";
		private HeadlessHud() { super(null); }
		@Override public void setOverlayMessage(Component message, boolean animateColor) { this.message = message.getString(); }
	}

	public static Supplier<String> install(Minecraft client) throws ReflectiveOperationException {
		HeadlessHud hud = allocate(HeadlessHud.class);
		hud.message = "";
		Gui shell = allocate(HeadlessGui.class);
		set(shell, Gui.class, "hud", hud);
		set(client, Minecraft.class, "gui", shell);
		return () -> hud.message;
	}

	@SuppressWarnings("unchecked")
	private static <T> T allocate(Class<T> type) throws ReflectiveOperationException {
		java.lang.reflect.Field field = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
		field.setAccessible(true);
		return (T) ((sun.misc.Unsafe) field.get(null)).allocateInstance(type);
	}

	private static void set(Object target, Class<?> owner, String name, Object value) throws ReflectiveOperationException {
		java.lang.reflect.Field field = owner.getDeclaredField(name);
		field.setAccessible(true);
		field.set(target, value);
	}
}
