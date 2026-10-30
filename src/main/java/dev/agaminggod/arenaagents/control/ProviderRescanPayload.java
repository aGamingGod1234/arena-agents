package dev.agaminggod.arenaagents.control;

import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.Identifier;

/** An operator's request to re-scan the server machine's provider CLIs, accounts and models. */
public record ProviderRescanPayload() implements CustomPacketPayload {
	public static final ProviderRescanPayload INSTANCE = new ProviderRescanPayload();
	public static final Type<ProviderRescanPayload> TYPE = new Type<>(
			Identifier.fromNamespaceAndPath("arenaagents", "provider_rescan")
	);
	public static final StreamCodec<RegistryFriendlyByteBuf, ProviderRescanPayload> CODEC = StreamCodec.unit(INSTANCE);

	@Override
	public Type<ProviderRescanPayload> type() {
		return TYPE;
	}
}
