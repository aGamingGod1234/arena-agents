package dev.agaminggod.arenaagents.compat;

import java.util.function.Supplier;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Gui;
import net.minecraft.network.chat.Component;

/** A headless HUD that records the last action-bar message, installed into an allocated Minecraft (26.1). */
public final class TestHud {
	private TestHud() {
	}

	private static final class HeadlessGui extends Gui {
		private String message = "";
		private HeadlessGui() { super(null); }
		@Override public void setOverlayMessage(Component message, boolean animateColor) { this.message = message.getString(); }
	}

	public static Supplier<String> install(Minecraft client) throws ReflectiveOperationException {
		HeadlessGui gui = allocate(HeadlessGui.class);
		gui.message = "";
		set(client, Minecraft.class, "gui", gui);
		return () -> gui.message;
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
