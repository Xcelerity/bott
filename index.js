// --- Dependencies ---
const { Client, GatewayIntentBits, ChannelType, PermissionsBitField, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, writeBatch, runTransaction, serverTimestamp, query, where } = require('firebase/firestore');
const { getAuth, signInAnonymously } = require('firebase/auth');
require('dotenv').config();

// --- Configuration ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const PREFIX = '.';
const DAILY_AMOUNT = 150;
const DAILY_COOLDOWN = 24 * 60 * 60 * 1000;

// --- Firebase Configuration ---
const firebaseConfig = {
    apiKey: "AIzaSyDraeeFdMF_gRKSWj7hTFAa8fb3wXbFjEs",
    authDomain: "babyyoda-d9e80.firebaseapp.com",
    projectId: "babyyoda-d9e80",
    storageBucket: "babyyoda-d9e80.firebasestorage.app",
    messagingSenderId: "439192308588",
    appId: "1:439192308588:web:f6b9594ffc6a9930fe4149",
    measurementId: "G-650G4G9E2R"
};

// --- Firebase Initialization ---
let db;
try {
    const app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    const auth = getAuth(app);
    signInAnonymously(auth).catch(error => {
        console.error("Firebase anonymous sign-in failed:", error);
    });
    console.log("Firebase initialized and connected successfully.");
} catch (error) {
    console.error("FATAL: Firebase initialization failed. Please check your firebaseConfig.", error);
    process.exit(1);
}

// --- Client Initialization ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// --- Bot Ready Event ---
client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}! Bot is ready.`);
    client.user.setActivity('the galaxy', { type: 'Watching' });

    // Start the interval to check for expired special location lobbies
    setInterval(checkExpiredLobbies, 60 * 1000);
});

// --- NEW: Event handler to keep display names in sync ---
client.on('guildMemberUpdate', async (oldMember, newMember) => {
    // If a member's nickname changes, update it in Firestore for fast lookups.
    if (oldMember.displayName !== newMember.displayName) {
        const playerData = await getDocument('players', newMember.id);
        if (playerData) {
            await setDocument('players', newMember.id, { displayName: newMember.displayName });
            console.log(`Updated display name for ${oldMember.displayName} to ${newMember.displayName}`);
        }
    }
});


// --- Firestore Helper Functions ---

/**
 * Retrieves a document from Firestore.
 * @param {string} collectionPath - The path to the collection.
 * @param {string} docId - The ID of the document.
 * @returns {Promise<object|null>} The document data or null if not found.
 */
async function getDocument(collectionPath, docId) {
    try {
        const docRef = doc(db, collectionPath, docId);
        const docSnap = await getDoc(docRef);
        return docSnap.exists() ? docSnap.data() : null;
    } catch (error) {
        console.error(`Error getting document '${docId}' from '${collectionPath}':`, error);
        return null;
    }
}

/**
 * Sets or overwrites a document in Firestore.
 * @param {string} collectionPath - The path to the collection.
 * @param {string} docId - The ID of the document.
 * @param {object} data - The data to set.
 * @returns {Promise<boolean>} True on success, false on failure.
 */
async function setDocument(collectionPath, docId, data) {
    try {
        const docRef = doc(db, collectionPath, docId);
        await setDoc(docRef, data, { merge: true });
        return true;
    } catch (error) {
        console.error(`Error setting document '${docId}' in '${collectionPath}':`, error);
        return false;
    }
}

/**
 * Deletes a document from Firestore.
 * @param {string} collectionPath - The path to the collection.
 * @param {string} docId - The ID of the document to delete.
 * @returns {Promise<boolean>} True on success, false on failure.
 */
async function deleteDocument(collectionPath, docId) {
    try {
        const docRef = doc(db, collectionPath, docId);
        await deleteDoc(docRef);
        return true;
    } catch (error) {
        console.error(`Error deleting document '${docId}' from '${collectionPath}':`, error);
        return false;
    }
}

/**
 * Deletes all documents in a specified collection.
 * @param {string} collectionPath - The path of the collection to clear.
 */
async function clearCollection(collectionPath) {
    try {
        const collectionRef = collection(db, collectionPath);
        const querySnapshot = await getDocs(collectionRef);
        if (querySnapshot.empty) {
            console.log(`Collection is already empty: ${collectionPath}`);
            return;
        }
        const batch = writeBatch(db);
        querySnapshot.forEach(doc => {
            batch.delete(doc.ref);
        });
        await batch.commit();
        console.log(`Successfully cleared collection: ${collectionPath}`);
    } catch (error) {
        console.error(`Error clearing collection '${collectionPath}':`, error);
    }
}


/**
 * Fetches the main game configuration document.
 * @returns {Promise<object>} The game state object.
 */
async function getGameState() {
    const state = await getDocument('game', 'state');
    const defaults = {
        isNight: false,
        permissionsConfigured: false,
        challengerPermissionsConfigured: false,
        visitsAllowed: false,
        knockTimeout: 2 * 60 * 1000,
        visitBlockedPlayers: [],
        whisperWordLimit: 10, // New default value
    };
    // Merge defaults with the retrieved state to ensure all properties exist.
    return { ...defaults, ...state };
}

/**
 * Updates the main game configuration document.
 * @param {object} updates - An object with the fields to update.
 */
async function updateGameState(updates) {
    await setDocument('game', 'state', updates);
}


// --- Helper Functions ---
/**
 * Creates a default player profile object.
 * @param {import('discord.js').GuildMember} member - The member to create the profile for.
 * @returns {object} The default profile object.
 */
function createDefaultProfile(member) {
    return {
        displayName: member.displayName, // Store the display name on creation
        profile: {
            roleName: 'Unassigned',
            team: 'Unassigned',
            abilityCategories: [],
            lore: 'Not set.',
            visits: {
                day: { regular: 0, special: 0, stealth: 0 },
                night: { regular: 0, special: 0, stealth: 0 },
            },
            abilities: {
                passive: [],
                active: [],
            },
            specialCount: 2,
        },
        wallet: 200,
        inventory: {},
        lastDailyClaim: 0,
    };
}

async function resetAllVotingSessions(guild) {
    const votingSessionsCollection = collection(db, 'votingSessions');
    const snapshot = await getDocs(votingSessionsCollection);
    const voteCountChannel = guild.channels.cache.find(c => c.name === 'voting-count');

    const batch = writeBatch(db);
    const deletePromises = [];

    snapshot.forEach(doc => {
        const session = doc.data();
        if (session.voteCountMessageId && voteCountChannel) {
            // Asynchronously delete messages, don't wait for them
            deletePromises.push(
                voteCountChannel.messages.delete(session.voteCountMessageId).catch(err => {
                    // Ignore errors for messages that might already be deleted
                    if (err.code !== 10008) {
                        console.error(`Could not delete tally message ${session.voteCountMessageId}:`, err);
                    }
                })
            );
        }
        batch.delete(doc.ref);
    });

    await Promise.all([batch.commit(), ...deletePromises]);
    console.log("All active voting sessions have been reset.");
}


/**
 * Checks if a command is being used in an allowed channel.
 * @param {import('discord.js').Message} message The message object.
 * @param {boolean} isAdmin Whether the author is an admin.
 * @param {boolean} isAlt Whether the author is an Alt.
 * @returns {boolean} True if the channel is allowed, false otherwise.
 */
function isAllowedInRoleChannel(message, isAdmin, isAlt) {
    if (isAdmin) return true; // Admins can use commands anywhere

    const guild = message.guild;
    const sanitizedDisplayName = message.member.displayName.toLowerCase().replace(/ /g, '-').replace(/[^\w-]+/g, '');

    // Determine which categories to check based on the user's role
    const categoriesToCheck = isAlt
        ? ['ALTS ROLE CHANNELS']
        : ['ROLE CHANNELS', 'WAITING ROLE CHANNELS', '💀 DEAD PLAYERS'];

    let userChannels = [];

    for (const catName of categoriesToCheck) {
        const category = guild.channels.cache.find(c => c.name === catName && c.type === ChannelType.GuildCategory);
        if (category) {
            const channelsInCategory = guild.channels.cache.filter(c =>
                c.parentId === category.id && c.name.startsWith(sanitizedDisplayName)
            );
            userChannels.push(...channelsInCategory.values());
        }
    }

    if (!userChannels.some(c => c.id === message.channel.id)) {
        const replyMessage = isAlt
            ? 'You can only use this command in your private alt channel.'
            : 'You can only use this command in your role channel.';
        message.reply({
            content: replyMessage,
            ephemeral: true
        });
        return false;
    }
    return true;
}


async function resetFullGameState() {
    const collectionsToClear = [
        'players', 'shipAssignments', 'initialAssignments', 'shopItems',
        'partners', 'presets', 'moveInRequests', 'shipModifiers',
        'destroyedShipOrigins', 'actionLogs', 'playerSpecialVisits',
        'specialLocations', 'votingSessions', 'specialLocationLobbies'
    ];

    await Promise.all(collectionsToClear.map(clearCollection));
    await deleteDocument('game', 'state'); // Delete the main state doc

    console.log("Full game state has been reset in Firestore.");
}

/**
 * NEW helper function to handle the assignment logic, reused for both new and occupied ships.
 * @param {import('discord.js').GuildMember} member - The member to assign.
 * @param {import('discord.js').TextChannel} assignedShip - The channel to assign the member to.
 * @param {import('discord.js').CategoryChannel} roleCategory - The category for role channels.
 */
async function processPlayerAssignment(member, assignedShip, roleCategory) {
    const guild = member.guild;
    const thrivingRole = guild.roles.cache.find(r => r.name === 'Thriving');

    await member.roles.add(thrivingRole);

    const playerDoc = await getDocument('players', member.id);
    if (!playerDoc) {
        await setDocument('players', member.id, createDefaultProfile(member));
    } else {
        await setDocument('players', member.id, { displayName: member.displayName });
    }

    // Set initial assignment (home ship)
    await setDocument('initialAssignments', member.id, { shipId: assignedShip.id });

    // Set current assignment and permissions
    const currentAssignment = await getDocument('shipAssignments', assignedShip.id);
    const occupants = new Set(currentAssignment?.occupants || []);
    occupants.add(member.id);
    await setDocument('shipAssignments', assignedShip.id, { occupants: Array.from(occupants) });
    await assignedShip.permissionOverwrites.create(member.id, { ViewChannel: true, SendMessages: true });
    
    // Update channel topic
    const occupantNames = await Promise.all(Array.from(occupants).map(async id => (await guild.members.fetch(id).catch(() => null))?.displayName || 'Unknown'));
    await assignedShip.setTopic(`Occupied by ${occupantNames.join(', ')}`);

    const welcomeMsg = await assignedShip.send(`👋 Welcome, **${member.displayName}**! This is your home base. Feel comfortable!`);
    await welcomeMsg.pin().catch(console.error);

    // Create personal role channel if it doesn't exist
    const channelName = member.displayName.toLowerCase().replace(/ /g, '-').replace(/[^\w-]+/g, '');
    const existingChannel = guild.channels.cache.find(c => c.name.startsWith(channelName));

    if (!existingChannel) {
        const playerChannel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: roleCategory.id,
            permissionOverwrites: [{ id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] }, { id: member.id, allow: [PermissionsBitField.Flags.ViewChannel] }, { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel] }]
        });
        await playerChannel.send(`Welcome, ${member}! You have been assigned to **${assignedShip.name}** in the **${assignedShip.parent.name}** system. Use \`.profile\` here to see your details.`);
    }
}

/**
 * REFACTORED: Handles all player movement logic efficiently.
 * This function is now highly optimized to prevent lag by fetching player display names
 * from Firestore in a single batch query, avoiding slow, repeated API calls to Discord.
 * @param {import('discord.js').GuildMember} visitorMember The member who is moving.
 * @param {import('discord.js').TextChannel | null} newShipChannel The destination ship, or null if leaving.
 * @param {'loud' | 'stealth'} narrationType The type of narration for the move.
 */
async function executePlayerMove(visitorMember, newShipChannel, narrationType) {
    const guild = visitorMember.guild;
    const thrivingRole = guild.roles.cache.find(r => r.name === 'Thriving');
    const partnerRole = guild.roles.cache.find(r => r.name === 'Partner');
    const challengerRole = guild.roles.cache.find(r => r.name === 'Challenger');
    const pingText = `${thrivingRole || ''} ${partnerRole || ''} ${challengerRole || ''}`;

    const partnerData = await getDocument('partners', visitorMember.id);
    const partnerId = partnerData ? partnerData.partnerId : null;
    const partnerMember = partnerId ? await guild.members.fetch(partnerId).catch(() => null) : null;

    // --- Helper to get display names from Firestore for performance ---
    async function getDisplayNames(idList) {
        if (!idList || idList.length === 0) return [];
        const namesMap = new Map();
        
        // Fetch known players from Firestore in one go.
        const playersRef = collection(db, 'players');
        const q = query(playersRef, where('__name__', 'in', idList));
        const playersSnapshot = await getDocs(q);
        playersSnapshot.forEach(doc => namesMap.set(doc.id, doc.data().displayName || 'Unknown'));

        // Build the final list, falling back to an API call only if a name is missing from Firestore.
        const names = await Promise.all(idList.map(async (id) => {
            if (namesMap.has(id)) return namesMap.get(id);
            const member = await guild.members.fetch(id).catch(() => null);
            return member ? member.displayName : 'Unknown';
        }));
        return names;
    }

    // --- Vacate old ship(s) ---
    const shipAssignmentsRef = collection(db, 'shipAssignments');
    const q = query(shipAssignmentsRef, where('occupants', 'array-contains', visitorMember.id));
    const oldAssignmentsSnapshot = await getDocs(q);

    const vacatePromises = [];
    for (const doc of oldAssignmentsSnapshot.docs) {
        const shipId = doc.id;
        let occupants = doc.data().occupants || [];
        const oldShip = guild.channels.cache.get(shipId);

        if (oldShip) {
            occupants = occupants.filter(id => id !== visitorMember.id && id !== partnerId);

            vacatePromises.push(oldShip.permissionOverwrites.delete(visitorMember.id, 'Player moved ships').catch(console.error));
            if (partnerMember) {
                vacatePromises.push(oldShip.permissionOverwrites.delete(partnerMember.id, 'Partner moved with player').catch(console.error));
            }

            if (occupants.length === 0) {
                vacatePromises.push(oldShip.setTopic('Occupied by nobody').catch(console.error));
                vacatePromises.push(deleteDocument('shipAssignments', shipId));
            } else {
                vacatePromises.push(setDocument('shipAssignments', shipId, { occupants }));
                const remainingOccupantNames = await getDisplayNames(occupants);
                vacatePromises.push(oldShip.setTopic(`Occupied by ${remainingOccupantNames.join(', ')}`).catch(console.error));
            }

            if (narrationType === 'loud') {
                vacatePromises.push(oldShip.send(`${pingText}\n💨 **${visitorMember.displayName}** has left the spaceship.`).catch(console.error));
            }
        }
    }
    await Promise.all(vacatePromises);

    // --- Assign new ship ---
    if (!newShipChannel) return;

    const assignPromises = [];
    const newShipAssignment = await getDocument('shipAssignments', newShipChannel.id);
    const newOccupants = new Set(newShipAssignment?.occupants || []);
    newOccupants.add(visitorMember.id);

    assignPromises.push(newShipChannel.permissionOverwrites.create(visitorMember.id, { ViewChannel: true, SendMessages: true }).catch(console.error));
    if (partnerMember) {
        newOccupants.add(partnerMember.id);
        assignPromises.push(newShipChannel.permissionOverwrites.create(partnerMember.id, { ViewChannel: true, SendMessages: true }).catch(console.error));
    }

    const newOccupantsArray = Array.from(newOccupants);
    assignPromises.push(setDocument('shipAssignments', newShipChannel.id, { occupants: newOccupantsArray }));

    const newOccupantNames = await getDisplayNames(newOccupantsArray);
    assignPromises.push(newShipChannel.setTopic(`Occupied by ${newOccupantNames.join(', ')}`).catch(console.error));

    if (narrationType === 'loud') {
        assignPromises.push(newShipChannel.send(`${pingText}\n✨ **${visitorMember.displayName}** has entered the spaceship.`).catch(console.error));
    }

    await Promise.all(assignPromises);
}


async function getAvailableShips(guild) {
    let allChannels = await guild.channels.fetch(undefined, { force: true });
    let shipChannels = allChannels.filter(c => c.name.startsWith('spaceship-') && c.type === ChannelType.GuildText);

    // Fetch all assigned ships from Firestore
    const assignedSnapshot = await getDocs(collection(db, 'initialAssignments'));
    const assignedShipIds = new Set(assignedSnapshot.docs.map(doc => doc.data().shipId));

    const availableShips = shipChannels.filter(c => !assignedShipIds.has(c.id));
    return Array.from(availableShips.values());
}

async function setDaytimePermissions(guild, canTalk) {
    const thrivingRole = guild.roles.cache.find(r => r.name === 'Thriving');
    if (!thrivingRole) return;
    const daytimeCategory = guild.channels.cache.find(c => c.name === 'DAYTIME' && c.type === ChannelType.GuildCategory);
    if (!daytimeCategory) return;
    const daytimeChannels = guild.channels.cache.filter(c => c.parentId === daytimeCategory.id);
    for (const channel of daytimeChannels.values()) {
        try {
            await channel.permissionOverwrites.edit(thrivingRole.id, { SendMessages: canTalk });
        } catch (error) {
            console.error(`Failed to set permissions for ${channel.name}:`, error);
        }
    }
}

async function updateVoteCount(votingChannel) {
    const guild = votingChannel.guild;
    const session = await getDocument('votingSessions', votingChannel.id);
    if (!session) return;

    const voteCountChannel = guild.channels.cache.find(c => c.name === 'voting-count');
    if (!voteCountChannel) return;

    const embed = new EmbedBuilder()
        .setColor('Orange')
        .setTitle(`Vote Tally: ${votingChannel.name}`)
        .setDescription('Current votes for this session:')
        .setTimestamp();

    const votes = session.votes || {};
    const voteEntries = Object.entries(votes);

    if (voteEntries.length === 0) {
        embed.addFields({ name: 'No votes yet', value: `Use \`${PREFIX}vote @player\` in ${votingChannel.toString()} to cast your vote.` });
    } else {
        const sortedVotes = voteEntries.sort((a, b) => b[1].length - a[1].length);
        const fields = [];
        for (const [targetId, voters] of sortedVotes) {
            const target = await guild.members.fetch(targetId).catch(() => null);
            const targetName = target ? target.displayName : 'Unknown Player';
            if (voters.length > 0) {
                fields.push({ name: `${targetName}: ${voters.length} vote(s)`, value: '\u200B' });
            }
        }
        if (fields.length === 0) {
            embed.addFields({ name: 'No votes yet', value: `Use \`${PREFIX}vote @player\` in ${votingChannel.toString()} to cast your vote.` });
        } else {
            embed.addFields(fields);
        }
    }

    try {
        if (session.voteCountMessageId) {
            const message = await voteCountChannel.messages.fetch(session.voteCountMessageId).catch(() => null);
            if (message) {
                await message.edit({ embeds: [embed] });
                return;
            }
        }
        const newMessage = await voteCountChannel.send({ embeds: [embed] });
        await updateDoc(doc(db, 'votingSessions', votingChannel.id), { voteCountMessageId: newMessage.id });
    } catch (error) {
        console.error(`Failed to update vote count message in #voting-count for session ${votingChannel.name}:`, error);
    }
}

async function getPlayerRoleChannel(guild, player) {
    if (!player) return null;

    const sanitizedDisplayName = player.displayName.toLowerCase().replace(/ /g, '-').replace(/[^\w-]+/g, '');

    // Search in relevant categories
    return guild.channels.cache.find(c =>
        (c.parent?.name === 'ROLE CHANNELS' || c.parent?.name === '💀 DEAD PLAYERS' || c.parent?.name === 'WAITING ROLE CHANNELS' || c.parent?.name === 'ALTS ROLE CHANNELS') &&
        c.name.startsWith(sanitizedDisplayName)
    );
}

// --- Interaction (Button) Handler ---
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    const guild = interaction.guild;
    const [action, ...rest] = interaction.customId.split('_');

    // --- St. Lazarus Spire Visit Handler ---
    if (action === 'sls-accept' || action === 'sls-deny') {
        const [visitorId] = rest;
        const slsData = await getDocument('specialLocations', 'sls');
        if (!slsData || interaction.user.id !== slsData.head) {
            return interaction.reply({ content: "Only the head of St. Lazarus Spire can respond to this request.", ephemeral: true });
        }
        await interaction.deferUpdate();

        const visitor = await guild.members.fetch(visitorId).catch(() => null);
        if (!visitor) {
            return interaction.message.edit({ content: 'The requesting player could not be found.', components: [] });
        }

        const visitorRoleChannel = await getPlayerRoleChannel(guild, visitor);

        if (action === 'sls-accept') {
            const visitors = slsData.visitors || [];
            visitors.push(visitorId);
            await setDocument('specialLocations', 'sls', { visitors });

            const specialLocationCategory = guild.channels.cache.find(c => c.name === 'SPECIAL LOCATION');
            if (specialLocationCategory) {
                const biometricCoreChannel = await guild.channels.create({
                    name: 'Biometric Core',
                    type: ChannelType.GuildText,
                    parent: specialLocationCategory.id,
                    permissionOverwrites: [
                        { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                        { id: visitorId, allow: [PermissionsBitField.Flags.ViewChannel] },
                        { id: slsData.head, allow: [PermissionsBitField.Flags.ViewChannel] },
                    ]
                });
                await biometricCoreChannel.send({ content: `Welcome, ${visitor} and ${interaction.member}.`});
            }
            await interaction.message.edit({ content: `You have accepted **${visitor.displayName}**'s request. They have entered the Biometric Core.`, components: [] });
            visitorRoleChannel?.send(`✅ Your request to visit St. Lazarus Spire was accepted.`);
        } else { // sls-deny
            await interaction.message.edit({ content: `You have denied **${visitor.displayName}**'s request.`, components: [] });
            visitorRoleChannel?.send(`❌ Your request to visit St. Lazarus Spire was denied.`);
        }
        return;
    }

    // --- Black Hole Visit Handler ---
    if (action === 'bh-accept' || action === 'bh-deny') {
        const [visitorId] = rest;
        const bhData = await getDocument('specialLocations', 'blackhole');
        if (!bhData || interaction.user.id !== bhData.head) {
            return interaction.reply({ content: "Only the head of the Black Hole can respond.", ephemeral: true });
        }
        await interaction.deferUpdate();

        const visitor = await guild.members.fetch(visitorId).catch(() => null);
        if (!visitor) {
            return interaction.message.edit({ content: 'The requesting player could not be found.', components: [] });
        }

        const visitorRoleChannel = await getPlayerRoleChannel(guild, visitor);

        if (action === 'bh-accept') {
            const visitors = bhData.visitors || [];
            visitors.push(visitorId);
            await setDocument('specialLocations', 'blackhole', { visitors });

            const specialLocationCategory = guild.channels.cache.find(c => c.name === 'SPECIAL LOCATION');
            if (specialLocationCategory) {
                const netherspireChannel = await guild.channels.create({
                    name: 'Netherspire',
                    type: ChannelType.GuildText,
                    parent: specialLocationCategory.id,
                    permissionOverwrites: [
                        { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                        { id: visitorId, allow: [PermissionsBitField.Flags.ViewChannel] },
                        { id: bhData.head, allow: [PermissionsBitField.Flags.ViewChannel] },
                    ]
                });
                await netherspireChannel.send({ content: `Welcome, ${visitor} and ${interaction.member}.` });
            }
            await interaction.message.edit({ content: `You have accepted **${visitor.displayName}**'s request. They have been sucked into the Netherspire.`, components: [] });
            visitorRoleChannel?.send(`✅ Your request to visit the Black Hole was accepted.`);
        } else { // bh-deny
            await interaction.message.edit({ content: `You have denied **${visitor.displayName}**'s request.`, components: [] });
            visitorRoleChannel?.send(`❌ Your request to visit the Black Hole was denied.`);
        }
        return;
    }

    // --- Cygnus Exchange Visit Handler ---
    if (action === 'cy-accept' || action === 'cy-deny') {
        const [visitorId] = rest;
        const cygnusData = await getDocument('specialLocations', 'cygnus');
        if (!cygnusData || interaction.user.id !== cygnusData.head) {
            return interaction.reply({ content: "Only the head of the Cygnus Exchange can respond.", ephemeral: true });
        }
        await interaction.deferUpdate();

        const visitor = await guild.members.fetch(visitorId).catch(() => null);
        if (!visitor) {
            return interaction.message.edit({ content: 'The requesting player could not be found.', components: [] });
        }

        const visitorRoleChannel = await getPlayerRoleChannel(guild, visitor);

        if (action === 'cy-accept') {
            const visitors = cygnusData.visitors || [];
            visitors.push(visitorId);
            await setDocument('specialLocations', 'cygnus', { visitors });

            const specialLocationCategory = guild.channels.cache.find(c => c.name === 'SPECIAL LOCATION');
            if (specialLocationCategory) {
                const consultationChannel = await guild.channels.create({
                    name: 'Consultation Room',
                    type: ChannelType.GuildText,
                    parent: specialLocationCategory.id,
                    permissionOverwrites: [
                        { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                        { id: visitorId, allow: [PermissionsBitField.Flags.ViewChannel] },
                        { id: cygnusData.head, allow: [PermissionsBitField.Flags.ViewChannel] },
                    ]
                });
                await consultationChannel.send({ content: `Welcome, ${visitor} and ${interaction.member}.`});
            }
            await interaction.message.edit({ content: `You have accepted **${visitor.displayName}**'s request. Enjoy scamming them inside the Consultation Room.`, components: [] });
            visitorRoleChannel?.send(`✅ Your request to visit the Cygnus Exchange was accepted.`);
        } else { // cy-deny
            await interaction.message.edit({ content: `You have denied **${visitor.displayName}**'s request.`, components: [] });
            visitorRoleChannel?.send(`❌ Your request to visit the Cygnus Exchange was denied.`);
        }
        return;
    }

    // --- La Famiglia Galattica Visit Handler ---
    if (action === 'la-accept' || action === 'la-deny') {
        const [visitorId] = rest;
        const laFamigliaData = await getDocument('specialLocations', 'laFamiglia');
        if (!laFamigliaData || interaction.user.id !== laFamigliaData.head) {
            return interaction.reply({ content: "Only the head of La Famiglia Galattica can respond.", ephemeral: true });
        }
        await interaction.deferUpdate();

        const visitor = await guild.members.fetch(visitorId).catch(() => null);
        if (!visitor) {
            return interaction.message.edit({ content: 'The requesting player could not be found.', components: [] });
        }

        const visitorRoleChannel = await getPlayerRoleChannel(guild, visitor);

        if (action === 'la-accept') {
            const visitors = laFamigliaData.visitors || [];
            visitors.push(visitorId);
            await setDocument('specialLocations', 'laFamiglia', { visitors });

            const specialLocationCategory = guild.channels.cache.find(c => c.name === 'SPECIAL LOCATION');
            if (specialLocationCategory) {
                const salaChannel = await guild.channels.create({
                    name: 'Sala da Pranzo',
                    type: ChannelType.GuildText,
                    parent: specialLocationCategory.id,
                    permissionOverwrites: [
                        { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                        { id: visitorId, allow: [PermissionsBitField.Flags.ViewChannel] },
                        { id: laFamigliaData.head, allow: [PermissionsBitField.Flags.ViewChannel] },
                    ]
                });
                await salaChannel.send({ content: `Welcome, ${visitor} and ${interaction.member}.` });
            }
            await interaction.message.edit({ content: `You have accepted **${visitor.displayName}**'s request. Feed them nicely in Sala da Pranzo.`, components: [] });
            visitorRoleChannel?.send(`✅ Your request to visit La Famiglia Galattica was accepted.`);
        } else { // la-deny
            await interaction.message.edit({ content: `You have denied **${visitor.displayName}**'s request.`, components: [] });
            visitorRoleChannel?.send(`❌ Your request to visit La Famiglia Galattica was denied.`);
        }
        return;
    }


    // --- Special Location Enter Handler ---
    if (action === 'special-enter') {
        const [locationId, visitorId] = rest;
        if (interaction.user.id !== visitorId) {
            return interaction.reply({ content: "This is not your decision to make.", ephemeral: true });
        }

        const lobbyData = await getDocument('specialLocationLobbies', visitorId);
        if (lobbyData) {
            const lobbyChannel = guild.channels.cache.get(lobbyData.channelId);
            const lobbyMessage = await lobbyChannel?.messages.fetch(lobbyData.messageId).catch(() => null);
            if (lobbyChannel) await lobbyChannel.permissionOverwrites.delete(visitorId, 'Player chose to enter.');
            if (lobbyMessage) await lobbyMessage.delete();
            await deleteDocument('specialLocationLobbies', visitorId);
        }

        await interaction.deferUpdate();

        const playerData = await getDocument('players', visitorId);
        if (!playerData) return;
        const profile = playerData.profile;

        const visitData = await getDocument('playerSpecialVisits', visitorId);
        const visitedTonight = visitData?.locations || [];
        if (visitedTonight.includes(locationId)) {
            const visitorRoleChannel = await getPlayerRoleChannel(guild, interaction.member);
            visitorRoleChannel?.send("You have already entered this location tonight.");
            return;
        }

        if (profile.specialCount <= 0) {
            const visitorRoleChannel = await getPlayerRoleChannel(guild, interaction.member);
            visitorRoleChannel?.send("You have no special location entries left for this phase.");
            return;
        }

        profile.specialCount--;
        visitedTonight.push(locationId);
        await setDocument('players', visitorId, { profile: profile });
        await setDocument('playerSpecialVisits', visitorId, { locations: visitedTonight });

        const locations = {
            '1': { name: 'sls', readable: 'St. Lazarus Spire', customId: 'sls' },
            '2': { name: 'blackhole', readable: 'Black Hole', customId: 'bh' },
            '3': { name: 'cygnus', readable: 'Cygnus Exchange', customId: 'cy' },
            '4': { name: 'laFamiglia', readable: 'La Famiglia Galattica', customId: 'la' }
        };

        const locInfo = locations[locationId];
        if (!locInfo) return;

        const locData = await getDocument('specialLocations', locInfo.name);
        if (!locData || !locData.head) {
            const visitorRoleChannel = await getPlayerRoleChannel(guild, interaction.member);
            visitorRoleChannel?.send(`${locInfo.readable} currently has no head and cannot be visited.`);
            return;
        }
        if ((locData.visitors || []).length >= locData.maxAllowed) {
            const visitorRoleChannel = await getPlayerRoleChannel(guild, interaction.member);
            visitorRoleChannel?.send(`${locInfo.readable} has reached its maximum visitor capacity.`);
            return;
        }

        const headMember = await guild.members.fetch(locData.head).catch(() => null);
        if (!headMember) {
            const visitorRoleChannel = await getPlayerRoleChannel(guild, interaction.member);
            visitorRoleChannel?.send(`The head of ${locInfo.readable} could not be found.`);
            return;
        }

        const headRoleChannel = await getPlayerRoleChannel(guild, headMember);
        if (!headRoleChannel) {
            const visitorRoleChannel = await getPlayerRoleChannel(guild, interaction.member);
            visitorRoleChannel?.send(`Could not find the role channel for the head of ${locInfo.readable} to send the request.`);
            return;
        }

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`${locInfo.customId}-accept_${visitorId}`).setLabel('Accept').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`${locInfo.customId}-deny_${visitorId}`).setLabel('Deny').setStyle(ButtonStyle.Danger)
        );
        await headRoleChannel.send({
            content: `**${interaction.member.displayName}** wishes to visit ${locInfo.readable}. Do you accept?`,
            components: [row]
        });

        const visitorRoleChannel = await getPlayerRoleChannel(guild, interaction.member);
        visitorRoleChannel?.send(`Your request to enter ${locInfo.readable} has been sent to the head. Please await confirmation here.`);
    }

    // --- Special Location Leave Handler ---
    if (action === 'special-leave') {
        const [channelType, ...memberIds] = rest;
        if (!memberIds.includes(interaction.user.id)) {
            return interaction.reply({ content: "This is not your decision to make.", ephemeral: true });
        }

        const channel = interaction.channel;
        await channel.delete('Session ended.');

        const locations = {
            'biometric-core': 'sls',
            'netherspire': 'blackhole',
            'consultation-room': 'cygnus',
            'sala-da-pranzo': 'laFamiglia'
        };
        const locName = locations[channelType];
        if (locName) {
            const locData = await getDocument('specialLocations', locName);
            if (locData && locData.visitors) {
                const updatedVisitors = locData.visitors.filter(id => !memberIds.includes(id));
                await setDocument('specialLocations', locName, { visitors: updatedVisitors });
            }
        }
    }

    // --- Main Special Location Leave Handler ---
    if (action === 'special-location-leave') {
        const [locationId, visitorId] = rest;
        if (interaction.user.id !== visitorId) {
            return interaction.reply({ content: "This is not your decision to make.", ephemeral: true });
        }
        await interaction.deferUpdate();
        const channel = interaction.channel;
        await channel.permissionOverwrites.delete(visitorId, 'Player left special location lobby.');
        await interaction.message.delete();
        await deleteDocument('specialLocationLobbies', visitorId);
        return;
    }

    // --- Visit Handler ---
    if (action === 'visit-open' || action === 'visit-deny') {
        const [visitorId, targetShipId] = rest;
        const thrivingRole = guild.roles.cache.find(r => r.name === 'Thriving');
        if (!interaction.member.roles.cache.has(thrivingRole?.id)) {
            return interaction.reply({ content: "Only thriving members of this spaceship can respond.", ephemeral: true });
        }

        await interaction.deferUpdate();

        const visitor = await guild.members.fetch(visitorId).catch(() => null);
        const targetShip = guild.channels.cache.get(targetShipId);

        if (!visitor || !targetShip) return;

        const visitorRoleChannel = await getPlayerRoleChannel(guild, visitor);

        if (action === 'visit-open') {
            await executePlayerMove(visitor, targetShip, 'loud');
            await interaction.message.edit({ content: `The door was opened.`, components: [] });
            if (visitorRoleChannel) await visitorRoleChannel.send(`✅ Your visit was accepted! You have moved to **${targetShip.name}**.`);
        } else if (action === 'visit-deny') {
            await interaction.message.edit({ content: `The door remains closed.`, components: [] });
            if (visitorRoleChannel) {
                const occupants = targetShip.members.filter(m => m.roles.cache.has(thrivingRole.id));
                const occupantNames = occupants.map(m => m.displayName).join(', ') || 'the occupants';
                await visitorRoleChannel.send(`❌ Your visit to **${targetShip.name}** was denied by **${occupantNames}**.`);
            }
        }
        return;
    }

    // --- Move In Handler ---
    if (action === 'movein-allow' || action === 'movein-deny') {
        const [requesterId] = rest;
        const request = await getDocument('moveInRequests', requesterId);

        if (!request || !request.homeowners[interaction.user.id]) {
            return interaction.reply({ content: "This is not your decision to make.", ephemeral: true });
        }

        await interaction.deferUpdate();

        const requester = await guild.members.fetch(requesterId).catch(() => null);
        if (!requester) {
            await deleteDocument('moveInRequests', requesterId);
            return interaction.message.edit({ content: 'The player who made this request could not be found.', components: [] });
        }

        const requesterRoleChannel = await getPlayerRoleChannel(guild, requester);

        if (action === 'movein-deny') {
            if (requesterRoleChannel) {
                requesterRoleChannel.send(`❌ Your request to move into **<#${request.targetShipId}>** was denied by **${interaction.user.username}**.`);
            }
            for (const homeownerId of Object.keys(request.homeowners)) {
                if (homeownerId !== interaction.user.id) {
                    const homeowner = await guild.members.fetch(homeownerId).catch(() => null);
                    const homeownerRoleChannel = await getPlayerRoleChannel(guild, homeowner);
                    homeownerRoleChannel?.send(`**${interaction.user.username}** denied **${requester.displayName}**'s request to move into your shared home.`);
                }
            }
            for (const [msgId, channelId] of Object.entries(request.messageIds)) {
                const homeownerChannel = guild.channels.cache.get(channelId);
                const originalMessage = await homeownerChannel?.messages.fetch(msgId).catch(() => null);
                originalMessage?.edit({ content: `Request denied by ${interaction.user.username}.`, components: [] });
            }
            await deleteDocument('moveInRequests', requesterId);
        } else { // movein-allow
            request.homeowners[interaction.user.id] = 'allowed';
            await setDocument('moveInRequests', requesterId, { homeowners: request.homeowners });
            interaction.message.edit({ content: `You have allowed **${requester.displayName}** to move in. Waiting for other homeowners...`, components: [] });

            const allAllowed = Object.values(request.homeowners).every(status => status === 'allowed');

            if (allAllowed) {
                const targetShip = guild.channels.cache.get(request.targetShipId);
                if (!targetShip) return;

                const oldHomeData = await getDocument('initialAssignments', requesterId);
                const oldHomeShipId = oldHomeData?.shipId;
                if (oldHomeShipId) {
                    const oldHomeShip = guild.channels.cache.get(oldHomeShipId);
                    if (oldHomeShip) {
                        const oldMsg = await oldHomeShip.send(`**${requester.displayName}** no longer lives here.`);
                        await oldMsg.pin().catch(console.error);
                    }
                }

                await setDocument('initialAssignments', requesterId, { shipId: request.targetShipId });

                const thrivingRole = guild.roles.cache.find(r => r.name === 'Thriving');
                const partnerRole = guild.roles.cache.find(r => r.name === 'Partner');
                const challengerRole = guild.roles.cache.find(r => r.name === 'Challenger');
                const pingText = `${thrivingRole || ''} ${partnerRole || ''} ${challengerRole || ''}`;
                const newMsg = await targetShip.send(`${pingText}\n**${requester.displayName}** now lives here.`);
                await newMsg.pin().catch(console.error);

                if (requesterRoleChannel) {
                    requesterRoleChannel.send(`✅ Your request to move into **${targetShip.name}** was approved! It is now your new home.`);
                }
                for (const homeownerId of Object.keys(request.homeowners)) {
                    const homeowner = await guild.members.fetch(homeownerId).catch(() => null);
                    const homeownerRoleChannel = await getPlayerRoleChannel(guild, homeowner);
                    homeownerRoleChannel?.send(`**${requester.displayName}** has successfully moved into your shared home, **${targetShip.name}**.`);
                }

                await deleteDocument('moveInRequests', requesterId);
            }
        }
    }
});


// --- Message Create Event ---
client.on('messageCreate', async message => {
    if (message.author.bot || !message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    const guild = message.guild;

    const isPlayer = message.member.roles.cache.some(r => r.name === 'Thriving');
    const isAlt = message.member.roles.cache.some(r => r.name === 'Alt'); // New role check
    const isAdmin = message.member.permissions.has(PermissionsBitField.Flags.Administrator);

    const playerCommands = ['profile', 'visit', 'vote', 'preset', 'home', 'movein', 'action', 'visitspecial', 'bal', 'balance', 'daily', 'shop', 'buy', 'inv', 'inventory', 'countday', 'whisper', 'sos', 'w'];
    const adminOnlyCommands = ['create', 'thriving', 'challenger', 'alt', 'close', 'list-ships', 'pc', 'dead', 'night', 'day', 'allowvisits', 'manipulate', 'votereset', 'reset', 'set-role-profile', 'set-visits', 'add-ability', 'public', 'setknocktimer', 'sethome', 'backhome', 'set-categories', 'allpresets', 'addpartner', 'destroy', 'special_to_regular', 'stealth_to_regular', 'visitblock', 'destroydoor', 'revive', 'alive', 'actions', 'sls', 'blackhole', 'cygnus', 'la', 'setspecialcount', 'where', 'gem-give', 'gem-take', 'gem-set', 'shop-add', 'shop-add-role', 'shop-remove', 'item-give', 'item-take', 'giveos', 'teleport', 'set-lore', 'count', 'setwhisperlimit', 'add-visits','who','deleteprofile'];

    if (adminOnlyCommands.includes(command) && !isAdmin) {
        return message.reply('You must be an Administrator to use that command.');
    }

    if (command === 'create' && isAdmin) {
        await resetFullGameState();
        const existingCategory = guild.channels.cache.find(channel => channel.name.includes('OVERSEER'));
        if (existingCategory) {
            return message.reply('The game world seems to have been created already. Please use secret first if you want to start a new game.');
        }
        await message.reply('🚀 **Astroverse is being created...** This might take a moment.');
        try {
            const rolesToCreate = [
                { name: 'Overseer', color: 'Red', permissions: [PermissionsBitField.Flags.Administrator] },
                { name: 'Thriving', color: 'Aqua' },
                { name: 'Partner', color: 'LuminousVividPink' },
                { name: 'Dead', color: 'Default' },
                { name: 'Challenger', color: 'Gold' },
                { name: 'Spectator', color: 'Grey' },
                { name: 'Alt', color: '#010101' } // Added Alt role
            ];
            for (const roleInfo of rolesToCreate) {
                if (!guild.roles.cache.find(r => r.name === roleInfo.name)) {
                    await guild.roles.create({
                        name: roleInfo.name,
                        color: roleInfo.color,
                        permissions: roleInfo.permissions || [],
                        reason: 'Game setup'
                    });
                }
            }
            const deadRole = guild.roles.cache.find(r => r.name === 'Dead');
            const spectatorRole = guild.roles.cache.find(r => r.name === 'Spectator');
            const altRole = guild.roles.cache.find(r => r.name === 'Alt');

            const overseerCategory = await guild.channels.create({
                name: '👁️ OVERSEER',
                type: ChannelType.GuildCategory,
                permissionOverwrites: [
                    { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                    { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel] },
                    { id: spectatorRole.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                    { id: altRole.id, deny: [PermissionsBitField.Flags.ViewChannel] } // Alt cannot see
                ],
            });
            const overseerChannels = ['💬 overseer-discussion', '📥 presets', '엑 actions', '✨ highlights', '🎙️ commentary', '📝 edit-and-del-logs', '🚪 join-leave-logs', '🗒️ notes'];
            for (const channelName of overseerChannels) {
                await guild.channels.create({ name: channelName, type: ChannelType.GuildText, parent: overseerCategory.id });
            }

            const techCategory = await guild.channels.create({ name: '⚙️ TECHNICAL STUFF', type: ChannelType.GuildCategory });
            await techCategory.permissionOverwrites.create(spectatorRole.id, { ViewChannel: true });
            await techCategory.permissionOverwrites.create(altRole.id, { ViewChannel: false }); // Alt cannot see category
            const techChannels = ['🚀 the-entrance', '📜 rules', '⚖️ alt-rules', '🎲 game-mechanics', '🛒 shop-items', '🃏 rolecard-template', '🗺️ map', '📋 playerlist', '❓ faq', '✅ confirm-if-playing'];
            for (const channelName of techChannels) {
                await guild.channels.create({ name: channelName, type: ChannelType.GuildText, parent: techCategory.id });
            }

            const categoriesToCreate = ['DAYTIME', 'PUBLIC CHANNELS', 'PRIVATE CHANNELS', 'SPECIAL LOCATION', 'TALKING'];
            for (const catName of categoriesToCreate) {
                const newCat = await guild.channels.create({
                    name: catName,
                    type: ChannelType.GuildCategory,
                    permissionOverwrites: [
                        { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                        { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel] },
                        { id: altRole.id, deny: [PermissionsBitField.Flags.ViewChannel] } // Alt cannot see
                    ]
                });
                await newCat.permissionOverwrites.create(spectatorRole.id, { ViewChannel: true });
            }
            const daytimeCategory = guild.channels.cache.find(c => c.name === 'DAYTIME');
            const daytimeChannels = ['day-discussion', 'megaphone', 'voting-channel-1', 'voting-channel-2', 'voting-count', 'announcement'];
            for (const channelName of daytimeChannels) {
                await guild.channels.create({ name: channelName, type: ChannelType.GuildText, parent: daytimeCategory.id });
            }
            const talkingCategory = guild.channels.cache.find(c => c.name === 'TALKING');
            const talkingChannels = ['mains-off-topic', 'alts-off-topic', 'spectator-lounge'];
            for (const channelName of talkingChannels) {
                await guild.channels.create({ name: channelName, type: ChannelType.GuildText, parent: talkingCategory.id });
            }
            await guild.channels.create({
                name: 'afterlife',
                type: ChannelType.GuildText,
                parent: talkingCategory.id,
                permissionOverwrites: [
                    { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                    { id: deadRole.id, allow: [PermissionsBitField.Flags.ViewChannel] },
                    { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel] }
                ]
            });

            const specialLocationCategory = guild.channels.cache.find(c => c.name === 'SPECIAL LOCATION');
            const specialLocationChannels = ['St. Lazarus Spire', 'Black Hole', 'Cygnus Exchange', 'La Famiglia Galattica'];
            for (const channelName of specialLocationChannels) {
                await guild.channels.create({ name: channelName.toLowerCase().replace(/ /g, '-').replace(/[^\w-]+/g, ''), type: ChannelType.GuildText, parent: specialLocationCategory.id });
            }

            const planetNames = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto'];
            let spaceshipNumbers = Array.from({ length: 40 }, (_, i) => i + 1);
            for (let i = spaceshipNumbers.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [spaceshipNumbers[i], spaceshipNumbers[j]] = [spaceshipNumbers[j], spaceshipNumbers[i]];
            }
            for (const planetName of planetNames) {
                const category = await guild.channels.create({
                    name: planetName,
                    type: ChannelType.GuildCategory,
                    permissionOverwrites: [
                        { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                        { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel] },
                        { id: altRole.id, deny: [PermissionsBitField.Flags.ViewChannel] } // Alt cannot see
                    ]
                });
                await category.permissionOverwrites.create(spectatorRole.id, { ViewChannel: true });

                for (let i = 0; i < 5; i++) {
                    const shipNumber = spaceshipNumbers.pop();
                    await guild.channels.create({ name: `spaceship-${shipNumber}`, type: ChannelType.GuildText, parent: category.id });
                }
            }

            await guild.channels.create({ name: '💀 DEAD PLAYERS', type: ChannelType.GuildCategory, permissionOverwrites: [{ id: altRole.id, deny: [PermissionsBitField.Flags.ViewChannel] }] });

            await message.channel.send('✅ **Welcome to Astroverse!**');
        } catch (error) {
            console.error('An error occurred while creating the game world:', error);
            await message.channel.send('❌ **An error occurred.** Please check my permissions (`Manage Channels`, `Manage Roles`) and try again.');
        }
    }
    else if (command === 'alt' && isAdmin) {
        const mentions = message.mentions.members;
        if (mentions.size === 0) {
            return message.reply('Please mention at least one player to assign the Alt role.');
        }

        let altRole = guild.roles.cache.find(r => r.name === 'Alt');
        if (!altRole) {
            return message.reply('The "Alt" role does not exist. Please run `.create` first.');
        }

        // Get or create the category for alt channels
        let altCategory = guild.channels.cache.find(c => c.name === 'ALTS ROLE CHANNELS' && c.type === ChannelType.GuildCategory);
        if (!altCategory) {
            altCategory = await guild.channels.create({
                name: 'ALTS ROLE CHANNELS',
                type: ChannelType.GuildCategory,
                permissionOverwrites: [
                    { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] }, // Deny @everyone
                    { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel] } // Allow bot
                ]
            });
        }

        const thrivingRole = guild.roles.cache.find(r => r.name === 'Thriving');
        const deadRole = guild.roles.cache.find(r => r.name === 'Dead');

        for (const member of mentions.values()) {
            await member.roles.add(altRole);
            if (thrivingRole) await member.roles.remove(thrivingRole).catch(() => {});
            if (deadRole) await member.roles.remove(deadRole).catch(() => {});

            // Ensure a profile exists for them to track visits
            const playerDoc = await getDocument('players', member.id);
            if (!playerDoc) {
                await setDocument('players', member.id, createDefaultProfile(member));
            }

            // Create their private channel
            const channelName = member.displayName.toLowerCase().replace(/ /g, '-').replace(/[^\w-]+/g, '');
            const existingChannel = guild.channels.cache.find(c => c.name === channelName && c.parentId === altCategory.id);
            if (!existingChannel) {
                const playerChannel = await guild.channels.create({
                    name: channelName,
                    type: ChannelType.GuildText,
                    parent: altCategory.id,
                    permissionOverwrites: [
                        { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                        { id: member.id, allow: [PermissionsBitField.Flags.ViewChannel] },
                        { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel] }
                    ]
                });
                await playerChannel.send(`Welcome, ${member}. You can use your Alt commands like \`.visit\` and \`.profile\` here.`);
            }
        }
        await message.reply(`✅ Assigned the **Alt** role to ${mentions.size} player(s) and created their private channels.`);
    }
    else if (command === 'giveos' && isAdmin) {
        const targetMember = message.mentions.members.first();
        if (!targetMember) {
            return message.reply(`Syntax: \`${PREFIX}giveos @player\``);
        }
        let overseerRole = guild.roles.cache.find(r => r.name === 'Overseer');
        if (!overseerRole) {
            return message.reply('The "Overseer" role does not exist. Please run `.create` to generate it.');
        }
        await targetMember.roles.add(overseerRole);
        await message.reply(`✅ Granted **Overseer** permissions to **${targetMember.displayName}**.`);
    }
    else if (command === 'thriving' && isAdmin) {
        const mentions = message.mentions.members;
        if (mentions.size === 0) {
            return message.reply('Please mention at least one player to make thriving.');
        }
        await message.reply(`✨ Processing ${mentions.size} assignment(s)...`);
        try {
            let thrivingRole = guild.roles.cache.find(r => r.name === 'Thriving');
            if (!thrivingRole) {
                thrivingRole = await guild.roles.create({ name: 'Thriving', color: 'Aqua', reason: 'Role for active game players' });
            }

            const gameState = await getGameState();
            if (!gameState.permissionsConfigured) {
                const categoriesToHide = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto', 'ROLE CHANNELS'];
                for (const catName of categoriesToHide) {
                    const category = guild.channels.cache.find(c => c.name === catName && c.type === ChannelType.GuildCategory);
                    if (category) {
                        await category.permissionOverwrites.edit(thrivingRole.id, { ViewChannel: false });
                    }
                }
                const categoriesToShow = ['DAYTIME', 'PUBLIC CHANNELS', 'PRIVATE CHANNELS', 'TALKING'];
                for (const catName of categoriesToShow) {
                    const category = guild.channels.cache.find(c => c.name === catName && c.type === ChannelType.GuildCategory);
                    if (category) {
                        await category.permissionOverwrites.edit(thrivingRole.id, { ViewChannel: true });
                    }
                }
                await updateGameState({ permissionsConfigured: true });
                await message.channel.send('🔒 Initial visibility permissions for the "Thriving" role have been set.');
            }

            let roleCategory = guild.channels.cache.find(c => c.name === 'ROLE CHANNELS' && c.type === ChannelType.GuildCategory);
            if (!roleCategory) {
                roleCategory = await guild.channels.create({ name: 'ROLE CHANNELS', type: ChannelType.GuildCategory });
            }

            const availableShips = await getAvailableShips(guild);
            const occupiedShipsSnapshot = await getDocs(collection(db, 'shipAssignments'));
            const occupiedShips = occupiedShipsSnapshot.docs.map(doc => guild.channels.cache.get(doc.id)).filter(c => c);
            
            const playersToAssign = [...mentions.values()];
            let assignedCount = 0;

            // First, assign to available ships
            for (let i = 0; i < availableShips.length && playersToAssign.length > 0; i++) {
                const member = playersToAssign.shift();
                const assignedShip = availableShips[i];
                await processPlayerAssignment(member, assignedShip, roleCategory);
                assignedCount++;
            }

            // Next, assign remaining players to occupied ships in a round-robin fashion
            if (playersToAssign.length > 0 && occupiedShips.length > 0) {
                let shipIndex = 0;
                while (playersToAssign.length > 0) {
                    const member = playersToAssign.shift();
                    const assignedShip = occupiedShips[shipIndex % occupiedShips.length];
                    await processPlayerAssignment(member, assignedShip, roleCategory);
                    assignedCount++;
                    shipIndex++;
                }
            } else if (playersToAssign.length > 0 && occupiedShips.length === 0) {
                return message.reply(`❌ No available ships could be found to assign the remaining ${playersToAssign.length} player(s).`);
            }


            const initialAssignmentsSnapshot = await getDocs(collection(db, 'initialAssignments'));
            await message.channel.send(`✅ Processed ${assignedCount} assignment(s). There are now ${initialAssignmentsSnapshot.size} unique players with home ships.`);
        } catch (error) {
            console.error('An error occurred during .thriving command:', error);
            await message.channel.send('❌ An error occurred. Please check my permissions (`Manage Roles`, `Manage Channels`, `Manage Messages`) and try again.');
        }
    }
    else if (command === 'challenger' && isAdmin) {
        const mentions = message.mentions.members;
        if (mentions.size === 0) {
            return message.reply('Please mention at least one player to make a challenger.');
        }
        await message.reply(`✨ Processing ${mentions.size} challenger(s)...`);

        try {
            let challengerRole = guild.roles.cache.find(r => r.name === 'Challenger');
            if (!challengerRole) {
                challengerRole = await guild.roles.create({ name: 'Challenger', color: 'Gold', reason: 'Role for challenger players' });
            }

            const gameState = await getGameState();
            if (!gameState.challengerPermissionsConfigured) {
                const categoriesToHide = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto', 'ROLE CHANNELS'];
                for (const catName of categoriesToHide) {
                    const category = guild.channels.cache.find(c => c.name === catName && c.type === ChannelType.GuildCategory);
                    if (category) {
                        await category.permissionOverwrites.edit(challengerRole.id, { ViewChannel: false });
                    }
                }

                const categoriesToShow = ['DAYTIME', 'PUBLIC CHANNELS', 'PRIVATE CHANNELS', 'TALKING'];
                for (const catName of categoriesToShow) {
                    const category = guild.channels.cache.find(c => c.name === catName && c.type === ChannelType.GuildCategory);
                    if (category) {
                        await category.permissionOverwrites.edit(challengerRole.id, { ViewChannel: true });
                    }
                }
                await updateGameState({ challengerPermissionsConfigured: true });
                await message.channel.send('🔒 Initial visibility permissions for the "Challenger" role have been set.');
            }

            let waitingCategory = guild.channels.cache.find(c => c.name === 'WAITING ROLE CHANNELS' && c.type === ChannelType.GuildCategory);
            if (!waitingCategory) {
                waitingCategory = await guild.channels.create({ name: 'WAITING ROLE CHANNELS', type: ChannelType.GuildCategory });
            }

            for (const member of mentions.values()) {
                await member.roles.add(challengerRole);
                const channelName = member.displayName;

                await guild.channels.create({
                    name: channelName,
                    type: ChannelType.GuildText,
                    parent: waitingCategory.id,
                    permissionOverwrites: [
                        { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                        { id: member.id, allow: [PermissionsBitField.Flags.ViewChannel] },
                        { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel] }
                    ]
                });
            }
            await message.channel.send(`✅ Processed ${mentions.size} challenger(s).`);
        } catch (error) {
            console.error('An error occurred during .challenger command:', error);
            await message.channel.send('❌ An error occurred. Please check my permissions.');
        }
    }
    else if (command === 'close' && isAdmin) {
        const channel = message.channel;
        const parent = channel.parent;

        if (!parent) {
            return message.reply('This channel is not in a category.');
        }

        let targetCategoryName;
        if (parent.name === 'PUBLIC CHANNELS') {
            targetCategoryName = 'CLOSED PUBLIC CHANNELS';
        } else if (parent.name === 'PRIVATE CHANNELS') {
            targetCategoryName = 'CLOSED PRIVATE CHANNELS';
        } else if (parent.name === 'SPECIAL LOCATION') {
            targetCategoryName = 'CLOSED SPECIAL CHANNELS';
        } else {
            return message.reply('This command can only be used in a channel under "PUBLIC CHANNELS", "PRIVATE CHANNELS", or "SPECIAL LOCATION".');
        }

        try {
            let targetCategory = guild.channels.cache.find(c => c.name === targetCategoryName && c.type === ChannelType.GuildCategory);
            if (!targetCategory) {
                const permissionOverwrites = [{ id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] }];
                if (targetCategoryName === 'CLOSED SPECIAL CHANNELS') {
                    // Make it admin-only
                    const overseerRole = guild.roles.cache.find(r => r.name === 'Overseer');
                    if (overseerRole) {
                        permissionOverwrites.push({ id: overseerRole.id, allow: [PermissionsBitField.Flags.ViewChannel] });
                    }
                }
                targetCategory = await guild.channels.create({
                    name: targetCategoryName,
                    type: ChannelType.GuildCategory,
                    permissionOverwrites: permissionOverwrites
                });
            }
            await channel.setParent(targetCategory.id, { lockPermissions: true });
            await message.reply(`✅ Moved this channel to the **${targetCategoryName}** category.`);
        } catch (error) {
            console.error(`Error in .close command:`, error);
            await message.reply('An error occurred while trying to close this channel. Please check my permissions.');
        }
    }
    else if (command === 'backhome' && isAdmin) {
        await message.reply('🚀 Returning all thriving players to their assigned home ships...');

        const thrivingRole = guild.roles.cache.find(r => r.name === 'Thriving');
        if (!thrivingRole) {
            return message.channel.send('Could not find the "Thriving" role.');
        }

        const thrivingMembers = await guild.members.fetch({ withPresences: false });
        const playersToMove = thrivingMembers.filter(m => m.roles.cache.has(thrivingRole.id));

        const movePromises = [];
        let movedCount = 0;

        for (const member of playersToMove.values()) {
            const homeData = await getDocument('initialAssignments', member.id);
            const homeShipId = homeData?.shipId;
            if (homeShipId) {
                const homeShipChannel = guild.channels.cache.get(homeShipId);
                if (homeShipChannel) {
                    const currentAssignment = await getDocument('shipAssignments', homeShipId);
                    const isAlreadyHome = currentAssignment?.occupants?.includes(member.id);

                    if (!isAlreadyHome) {
                        movePromises.push(executePlayerMove(member, homeShipChannel, 'loud'));
                        movedCount++;
                    }
                }
            }
        }

        await Promise.all(movePromises);
        await message.channel.send(`✅ Return sequence complete. ${movedCount} player(s) have been moved back to their home ships.`);
    }
    else if (command === 'sethome' && isAdmin) {
        const targetMember = message.mentions.members.first();
        const newHomeShip = message.mentions.channels.first();

        if (!targetMember || !newHomeShip) {
            return message.reply(`Syntax: \`${PREFIX}sethome @player #spaceship-channel\``);
        }

        if (!newHomeShip.name.startsWith('spaceship-') || newHomeShip.type !== ChannelType.GuildText) {
            return message.reply('You can only set a valid spaceship channel as a home ship.');
        }

        const playerDoc = await getDocument('players', targetMember.id);
        if (!playerDoc) {
            return message.reply("That player does not have a profile. Make them 'Thriving' first to assign a home ship.");
        }

        const oldHomeData = await getDocument('initialAssignments', targetMember.id);
        const oldHomeShipId = oldHomeData?.shipId;
        if (oldHomeShipId) {
            const oldHomeShip = guild.channels.cache.get(oldHomeShipId);
            if (oldHomeShip) {
                const oldMsg = await oldHomeShip.send(`**${targetMember.displayName}** no longer lives here.`);
                await oldMsg.pin().catch(console.error);
            }
        }

        const thrivingRole = guild.roles.cache.find(r => r.name === 'Thriving');
        const partnerRole = guild.roles.cache.find(r => r.name === 'Partner');
        const challengerRole = guild.roles.cache.find(r => r.name === 'Challenger');
        const pingText = `${thrivingRole || ''} ${partnerRole || ''} ${challengerRole || ''}`;

        const newMsg = await newHomeShip.send(`${pingText}\n**${targetMember.displayName}** now lives here.`);
        await newMsg.pin().catch(console.error);

        await setDocument('initialAssignments', targetMember.id, { shipId: newHomeShip.id });

        await message.reply(`✅ Updated **${targetMember.displayName}**'s home ship to **${newHomeShip.name}**.`);
    }
    else if (command === 'addpartner' && isAdmin) {
        const mentionedMembers = message.mentions.members;
        if (mentionedMembers.size !== 2) {
            return message.reply(`Syntax: \`${PREFIX}addpartner @player @partner\``);
        }

        const [player, partner] = mentionedMembers.values();

        if (!player.roles.cache.some(r => r.name === 'Thriving')) {
            return message.reply(`The first mentioned user (**${player.displayName}**) must have the "Thriving" role.`);
        }

        let partnerRole = guild.roles.cache.find(r => r.name === 'Partner');
        if (!partnerRole) {
            partnerRole = await guild.roles.create({ name: 'Partner', color: 'LuminousVividPink', reason: 'Role for player partners' });
        }
        await partner.roles.add(partnerRole);

        await setDocument('partners', player.id, { partnerId: partner.id });

        const roleChannelsCategory = guild.channels.cache.find(c => c.name === 'ROLE CHANNELS' && c.type === ChannelType.GuildCategory);
        if (roleChannelsCategory) {
            const playerChannels = guild.channels.cache.filter(c => c.parentId === roleChannelsCategory.id && c.name.startsWith(player.displayName));
            for (const pc of playerChannels.values()) {
                await pc.permissionOverwrites.create(partner.id, { ViewChannel: true });
            }
        }

        const homeData = await getDocument('initialAssignments', player.id);
        const homeShipId = homeData?.shipId;
        if (homeShipId) {
            const homeShipChannel = guild.channels.cache.get(homeShipId);
            if (homeShipChannel) {
                await homeShipChannel.permissionOverwrites.create(partner.id, { ViewChannel: true, SendMessages: true });
            }
        }

        await message.reply(`✅ **${partner.displayName}** is now partnered with **${player.displayName}** and will follow them.`);
    }
    else if (command === 'set-role-profile' && isAdmin) {
        const targetMember = message.mentions.members.first();
        if (!targetMember) {
            return message.reply(`Syntax: \`${PREFIX}set-role-profile @player <Role Name> <Team>\``);
        }
        const profileArgs = args.slice(1);
        const roleName = profileArgs[0];
        const team = profileArgs[1];
        if (!roleName || !team) {
            return message.reply(`Syntax: \`${PREFIX}set-role-profile @player <Role Name> <Team>\``);
        }

        const playerData = await getDocument('players', targetMember.id);
        if (!playerData) {
            return message.reply("That player does not have a profile. Make them 'Thriving' first.");
        }

        playerData.profile.roleName = roleName.replace(/-/g, ' ');
        playerData.profile.team = team.replace(/-/g, ' ');
        await setDocument('players', targetMember.id, { profile: playerData.profile });
        await message.reply(`✅ Updated ${targetMember.displayName}'s profile. Role: **${playerData.profile.roleName}**, Team: **${playerData.profile.team}**.`);
    }
    else if (command === 'set-lore' && isAdmin) {
        const targetMember = message.mentions.members.first();
        if (!targetMember) {
            return message.reply(`Syntax: \`${PREFIX}set-lore @player "<lore text>"\``);
        }

        const loreMatch = message.content.match(/"(.*?)"/);
        const loreText = loreMatch ? loreMatch[1] : null;

        if (!loreText) {
            return message.reply(`Please provide the lore text in quotes. Syntax: \`${PREFIX}set-lore @player "<lore text>"\``);
        }

        const playerData = await getDocument('players', targetMember.id);
        if (!playerData) {
            return message.reply("That player does not have a profile. Make them 'Thriving' first.");
        }

        playerData.profile.lore = loreText;
        await setDocument('players', targetMember.id, { profile: playerData.profile });
        await message.reply(`✅ Updated **${targetMember.displayName}**'s lore.`);
    }
    else if (command === 'set-categories' && isAdmin) {
        const targetMember = message.mentions.members.first();
        if (!targetMember) {
            return message.reply(`Syntax: \`${PREFIX}set-categories @player <Category1> <Category2>...\``);
        }
        const categories = args.slice(1);
        if (categories.length === 0) {
            return message.reply(`Please provide at least one category. Usage: \`${PREFIX}set-categories @player <Category1> <Category2>...\``);
        }

        const playerData = await getDocument('players', targetMember.id);
        if (!playerData) {
            return message.reply("That player does not have a profile. Make them 'Thriving' first.");
        }

        playerData.profile.abilityCategories = categories;
        await setDocument('players', targetMember.id, { profile: playerData.profile });
        await message.reply(`✅ Set ${targetMember.displayName}'s ability categories to: **${categories.join(', ')}**.`);
    }
    else if (command === 'set-visits' && isAdmin) {
        const targetMember = message.mentions.members.first();
        const [timeOfDay, visitType, countStr] = args.slice(1);
        const count = parseInt(countStr);

        if (!targetMember || !['day', 'night'].includes(timeOfDay) || !['regular', 'special', 'stealth'].includes(visitType) || isNaN(count)) {
            return message.reply(`Syntax: \`${PREFIX}set-visits @player <day|night> <regular|special|stealth> <number>\``);
        }

        // Ensure a profile exists before trying to update it
        const playerData = await getDocument('players', targetMember.id) || createDefaultProfile(targetMember);

        playerData.profile.visits[timeOfDay][visitType] = count;
        await setDocument('players', targetMember.id, { profile: playerData.profile });
        await message.reply(`✅ Set ${targetMember.displayName}'s **${timeOfDay} ${visitType}** visits to **${count}**.`);
    }
    else if (command === 'add-visits' && isAdmin) {
        const targetMember = message.mentions.members.first();
        const [dayRegStr, daySpecStr, dayStealthStr, nightRegStr, nightSpecStr, nightStealthStr] = args.slice(1);
        const dayReg = parseInt(dayRegStr);
        const daySpec = parseInt(daySpecStr);
        const dayStealth = parseInt(dayStealthStr);
        const nightReg = parseInt(nightRegStr);
        const nightSpec = parseInt(nightSpecStr);
        const nightStealth = parseInt(nightStealthStr);

        if (!targetMember || isNaN(dayReg) || isNaN(daySpec) || isNaN(dayStealth) || isNaN(nightReg) || isNaN(nightSpec) || isNaN(nightStealth)) {
            return message.reply(`Syntax: \`${PREFIX}add-visits @player <day_reg> <day_spec> <day_stealth> <night_reg> <night_spec> <night_stealth>\``);
        }

        const playerData = await getDocument('players', targetMember.id) || createDefaultProfile(targetMember);
        const profile = playerData.profile;

        profile.visits.day.regular += dayReg;
        profile.visits.day.special += daySpec;
        profile.visits.day.stealth += dayStealth;
        profile.visits.night.regular += nightReg;
        profile.visits.night.special += nightSpec;
        profile.visits.night.stealth += nightStealth;

        await setDocument('players', targetMember.id, { profile: profile });
        await message.reply(`✅ Added visits to **${targetMember.displayName}**:\n` +
            `Day: +${dayReg} Regular, +${daySpec} Special, +${dayStealth} Stealth\n` +
            `Night: +${nightReg} Regular, +${nightSpec} Special, +${nightStealth} Stealth`);
    }
    else if (command === 'setspecialcount' && isAdmin) {
        const targetMember = message.mentions.members.first();
        const count = parseInt(args[1]);

        if (!targetMember || isNaN(count)) {
            return message.reply(`Syntax: \`${PREFIX}setspecialcount @player <number>\``);
        }
        const playerData = await getDocument('players', targetMember.id);
        if (!playerData) {
            return message.reply("That player does not have a profile.");
        }
        playerData.profile.specialCount = count;
        await setDocument('players', targetMember.id, { profile: playerData.profile });
        await message.reply(`✅ Set **${targetMember.displayName}**'s special location entry count to **${count}**.`);
    }
    else if (command === 'add-ability' && isAdmin) {
        const targetMember = message.mentions.members.first();
        const abilityType = args[1];

        if (!targetMember || !['passive', 'active'].includes(abilityType)) {
            return message.reply(`Syntax:\n\`${PREFIX}add-ability @player passive <priority> <description>\`\n\`${PREFIX}add-ability @player active <priority> <category> <description>\``);
        }

        const playerData = await getDocument('players', targetMember.id);
        if (!playerData) {
            return message.reply("That player does not have a profile. Make them 'Thriving' first.");
        }
        const profile = playerData.profile;

        if (abilityType === 'passive') {
            const priority = parseInt(args[2]);
            const description = args.slice(3).join(' ');
            if (isNaN(priority) || !description) {
                return message.reply(`Syntax: \`${PREFIX}add-ability @player passive <priority> <description>\``);
            }
            profile.abilities.passive.push({ priority, description });
            await setDocument('players', targetMember.id, { profile });
            await message.reply(`✅ Added a new **Innate Superpower** for ${targetMember.displayName}.`);
        } else if (abilityType === 'active') {
            const priority = parseInt(args[2]);
            const category = args[3];
            const description = args.slice(4).join(' ');
            if (isNaN(priority) || !category || !description) {
                return message.reply(`Syntax: \`${PREFIX}add-ability @player active <priority> <category> <description>\``);
            }
            profile.abilities.active.push({ priority, category, description });
            await setDocument('players', targetMember.id, { profile });
            await message.reply(`✅ Added a new **Superpower** for ${targetMember.displayName}.`);
        }
    }
    else if (command === 'home') {
        if (!isPlayer && !isAdmin) {
            return message.reply('You must have the "Thriving" role to use this command.');
        }
        if (!isAllowedInRoleChannel(message, isAdmin, isAlt)) return;

        const homeData = await getDocument('initialAssignments', message.author.id);
        const homeShipId = homeData?.shipId;
        if (!homeShipId) {
            return message.reply("You don't have a home ship assigned. An admin may need to assign you one.");
        }

        const homeShipChannel = guild.channels.cache.get(homeShipId);
        if (!homeShipChannel) {
            return message.reply("Your assigned home ship seems to no longer exist. Please contact an admin.");
        }

        const currentAssignment = await getDocument('shipAssignments', homeShipId);
        if (currentAssignment?.occupants?.includes(message.author.id)) {
            return message.reply(`You are already at your home ship, **${homeShipChannel.name}**.`);
        }

        await executePlayerMove(message.member, homeShipChannel, 'loud');
        await message.reply(`🚀 You have returned to your home ship, **${homeShipChannel.name}**.`);
    }
    else if (command === 'movein') {
        if (!isPlayer && !isAdmin) {
            return message.reply('You must have the "Thriving" role to use this command.');
        }
        if (!isAllowedInRoleChannel(message, isAdmin, isAlt)) return;
        const targetShip = message.mentions.channels.first();
        if (!targetShip || !targetShip.name.startsWith('spaceship-')) {
            return message.reply(`Invalid syntax. Use: \`${PREFIX}movein #spaceship-channel\``);
        }

        const currentAssignment = await getDocument('shipAssignments', targetShip.id);
        if (!currentAssignment?.occupants?.includes(message.author.id)) {
            return message.reply(`You must be currently visiting **${targetShip.name}** to request a move-in.`);
        }

        const initialAssignmentsSnapshot = await getDocs(collection(db, 'initialAssignments'));
        const homeowners = initialAssignmentsSnapshot.docs
            .filter(doc => doc.data().shipId === targetShip.id)
            .map(doc => doc.id);

        // UPDATED LOGIC: If the ship has no owners, the player claims it.
        if (homeowners.length === 0) {
            const requester = message.member;
            const requesterRoleChannel = await getPlayerRoleChannel(guild, requester);

            // Announce departure from the old home
            const oldHomeData = await getDocument('initialAssignments', requester.id);
            if (oldHomeData && oldHomeData.shipId) {
                const oldHomeShip = guild.channels.cache.get(oldHomeData.shipId);
                if (oldHomeShip) {
                    const oldMsg = await oldHomeShip.send(`**${requester.displayName}** no longer lives here.`);
                    await oldMsg.pin().catch(console.error);
                }
            }

            // Set the new home in the database
            await setDocument('initialAssignments', requester.id, { shipId: targetShip.id });

            // Announce arrival in the new home
            const thrivingRole = guild.roles.cache.find(r => r.name === 'Thriving');
            const partnerRole = guild.roles.cache.find(r => r.name === 'Partner');
            const challengerRole = guild.roles.cache.find(r => r.name === 'Challenger');
            const pingText = `${thrivingRole || ''} ${partnerRole || ''} ${challengerRole || ''}`;
            const newMsg = await targetShip.send(`${pingText}\n**${requester.displayName}** now lives here.`);
            await newMsg.pin().catch(console.error);

            // Confirm with the player
            if (requesterRoleChannel) {
                requesterRoleChannel.send(`✅ You have successfully claimed **${targetShip.name}** as your new home!`);
            }
            await message.reply(`✅ You have successfully claimed the empty spaceship **${targetShip.name}** as your new home!`);
            return;
        }

        const existingRequest = await getDocument('moveInRequests', message.author.id);
        if (existingRequest) {
            return message.reply("You already have a pending move-in request. Please wait for it to be resolved.");
        }

        const request = {
            requesterId: message.author.id,
            targetShipId: targetShip.id,
            homeowners: homeowners.reduce((acc, id) => ({ ...acc, [id]: 'pending' }), {}),
            messageIds: {} // Store msgId -> channelId
        };

        const thrivingRole = guild.roles.cache.find(r => r.name === 'Thriving');
        const partnerRole = guild.roles.cache.find(r => r.name === 'Partner');
        const challengerRole = guild.roles.cache.find(r => r.name === 'Challenger');
        const pingText = `${thrivingRole || ''} ${partnerRole || ''} ${challengerRole || ''}`;

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`movein-allow_${message.author.id}`).setLabel('Allow').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`movein-deny_${message.author.id}`).setLabel('Deny').setStyle(ButtonStyle.Danger)
        );

        for (const homeownerId of homeowners) {
            const homeowner = await guild.members.fetch(homeownerId).catch(() => null);
            const roleChannel = await getPlayerRoleChannel(guild, homeowner);
            if (roleChannel) {
                const reqMsg = await roleChannel.send({
                    content: `${pingText}\n**${message.member.displayName}** wants to become your roommate and move into **${targetShip.name}**. Do you allow it?`,
                    components: [row]
                });
                request.messageIds[reqMsg.id] = roleChannel.id;
            }
        }

        if (Object.keys(request.messageIds).length > 0) {
            await setDocument('moveInRequests', message.author.id, request);
            await message.reply(`Your request to move into **${targetShip.name}** has been sent to the homeowner(s).`);
        } else {
            await message.reply(`Could not send the request to any homeowners.`);
        }
    }
    else if (command === 'profile') {
        const mentionedMember = message.mentions.members.first();
        let targetMember;
        const isViewingSelf = !mentionedMember || mentionedMember.id === message.author.id;

        if (mentionedMember) {
            if (!isAdmin) {
                return message.reply("Only administrators can view other players' profiles.");
            }
            targetMember = mentionedMember;
        } else {
            targetMember = message.member;
            if (!isPlayer && !isAlt && !isAdmin) {
                return message.reply('You must have the "Thriving" or "Alt" role to use this command.');
            }
            if (!isAllowedInRoleChannel(message, isAdmin, isAlt)) return;
        }

        const playerData = await getDocument('players', targetMember.id);
        if (!playerData || !playerData.profile) {
            const replyText = isViewingSelf
                ? "I couldn't find your profile. Please contact an admin."
                : `I couldn't find a profile for ${targetMember.displayName}. They may need the 'Thriving' or 'Alt' role first.`;
            return message.reply({ content: replyText, ephemeral: true });
        }
        const profile = playerData.profile;
        const targetIsAlt = targetMember.roles.cache.some(r => r.name === 'Alt');

        const profileEmbed = new EmbedBuilder()
            .setColor('#00ffff') // A futuristic cyan color
            .setAuthor({ name: `Welcome ${targetMember.displayName}`, iconURL: 'https://img.freepik.com/free-psd/stunning-3d-render-ringed-planet-celestial-body-cosmic-wonder_191095-79308.jpg?semt=ais_hybrid&w=740&q=80' })
            .setThumbnail(targetMember.displayAvatarURL({ dynamic: true, size: 256 }))
            .setTimestamp()
            .setFooter({ text: 'Astroverse Terminal', iconURL: 'https://img.freepik.com/free-psd/stunning-3d-render-ringed-planet-celestial-body-cosmic-wonder_191095-79308.jpg?semt=ais_hybrid&w=740&q=80' });
    
        const wallet = playerData.wallet || 0;
        const inventory = playerData.inventory || {};
        const itemCount = Object.values(inventory).reduce((sum, item) => sum + item.count, 0);
        profileEmbed.addFields({
            name: '`[ 💎 RESOURCES ]`',
            value: `**Gems:** ${wallet}\n**Items:** ${itemCount} held`
        });
    
        profileEmbed.addFields(
            { name: '`[ 🚀 DAY VISITS ]`', value: `**Regular:** ${profile.visits.day.regular}\n**Special:** ${profile.visits.day.special}\n**Stealth:** ${profile.visits.day.stealth}`, inline: true },
            { name: '`[ 🌙 NIGHT VISITS ]`', value: `**Regular:** ${profile.visits.night.regular}\n**Special:** ${profile.visits.night.special}\n**Stealth:** ${profile.visits.night.stealth}`, inline: true },
        );
    
        if (!targetIsAlt) {
            const showPriority = isAdmin && !isViewingSelf;
    
            const innateSuperpowersText = profile.abilities.passive.length > 0
                ? profile.abilities.passive
                    .sort((a, b) => a.priority - b.priority)
                    .map((a, i) => `> **[I${i + 1}]** ${showPriority ? `(P:${a.priority}) ` : ''}${a.description}`)
                    .join('\n')
                : '> No protocols installed.';
    
            const superpowersText = profile.abilities.active.length > 0
                ? profile.abilities.active
                    .sort((a, b) => a.priority - b.priority)
                    .map((a, i) => `> **[S${i + 1}]** ${showPriority ? `(P:${a.priority}) ` : ''}[${a.category}] ${a.description}`)
                    .join('\n')
                : '> No abilities available.';
    
            profileEmbed.addFields(
                { name: '\u200B', value: '\u200B' },
                { name: '`[ 🆔 INTRODUCTION ]`', value: `**Role Name:** ${profile.roleName}\n**Team:** ${profile.team}\n**Ability Categories:** ${(profile.abilityCategories && profile.abilityCategories.length > 0) ? profile.abilityCategories.join(', ') : 'None'}` },
                { name: '`[ 📜 LORE ]`', value: `>>> ${profile.lore || 'Not set.'}` },
                { name: '`[ ✨ SPECIAL ENTRIES ]`', value: `**Visits Left:** ${profile.specialCount}`, inline: true },
                { name: '\u200B', value: '\u200B', inline: true },
                { name: '\u200B', value: '\u200B', inline: true },
                { name: '`[ ⚙️ INNATE SUPERPOWERS ]`', value: innateSuperpowersText },
                { name: '`[ ⚡ SUPERPOWERS ]`', value: superpowersText }
            );
        } else {
            profileEmbed.setDescription('**Status:** Standby Mode (Alt Account)');
        }
    
        await message.channel.send({ embeds: [profileEmbed] });
    }
    else if (command === 'list-ships' && isAdmin) {
        await message.reply('🔍 Performing a detailed scan for available spaceships...');
        try {
            const availableShips = await getAvailableShips(guild);
            if (availableShips.length === 0) {
                return message.channel.send('Scan complete: No available spaceships found.');
            }
            const shipList = availableShips.map(ship => ship.name).join('\n');
            const embed = new EmbedBuilder()
                .setColor('Green')
                .setTitle(`Available Spaceships (${availableShips.length})`)
                .setDescription(shipList.substring(0, 4000));
            await message.channel.send({ embeds: [embed] });
        } catch (error) {
            console.error('Error in .list-ships command:', error);
            await message.channel.send('An error occurred while listing ships.');
        }
    }
    else if (command === 'pc' && isAdmin) {
        const type = args.shift()?.toLowerCase();
        const channelName = args.shift();
        const mentionedMembers = message.mentions.members;

        if (!['public', 'private'].includes(type) || !channelName || mentionedMembers.size === 0) {
            return message.reply(`Syntax: \`${PREFIX}pc <public|private> <channel-name> @Player1 @Player2...\``);
        }

        const categoryName = type === 'public' ? 'PUBLIC CHANNELS' : 'PRIVATE CHANNELS';
        const targetCategory = guild.channels.cache.find(c => c.name === categoryName && c.type === ChannelType.GuildCategory);

        if (!targetCategory) {
            return message.reply(`The category "${categoryName}" could not be found. Please run the \`.create\` command first.`);
        }

        try {
            let pcChannel = guild.channels.cache.find(c => c.name === channelName && c.parentId === targetCategory.id);
            if (pcChannel) {
                await message.reply(`Channel \`${channelName}\` already exists in ${categoryName}. Adding members...`);
                for (const member of mentionedMembers.values()) {
                    await pcChannel.permissionOverwrites.create(member.id, { ViewChannel: true });
                }
                await message.channel.send(`Added ${mentionedMembers.size} members to **#${channelName}**.`);
            } else {
                await message.reply(`Creating new ${type} channel: \`${channelName}\`...`);
                const permissionOverwrites = [{ id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] }, { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel] }];
                for (const member of mentionedMembers.values()) {
                    permissionOverwrites.push({ id: member.id, allow: [PermissionsBitField.Flags.ViewChannel] });
                }
                pcChannel = await guild.channels.create({ name: channelName, type: ChannelType.GuildText, parent: targetCategory.id, permissionOverwrites: permissionOverwrites });
                await message.channel.send(`✅ Created **#${pcChannel.name}** and added ${mentionedMembers.size} members.`);
            }
        } catch (error) {
            console.error('Error in .pc command:', error);
            await message.channel.send('An error occurred. Please check my permissions (`Manage Channels`).');
        }
    }
    else if (command === 'dead' && isAdmin) {
        const targetMember = message.mentions.members.first();
        if (!targetMember) {
            return message.reply(`Please mention a player to mark as dead. Syntax: \`${PREFIX}dead @player\``);
        }
        await message.reply(`Processing the death of ${targetMember.displayName}...`);

        try {
            const thrivingRole = guild.roles.cache.find(r => r.name === 'Thriving');
            const partnerRole = guild.roles.cache.find(r => r.name === 'Partner');
            let deadRole = guild.roles.cache.find(r => r.name === 'Dead');
            if (!deadRole) {
                deadRole = await guild.roles.create({ name: 'Dead', color: 'Default', reason: 'For players who have been eliminated.' });
            }

            const partnerData = await getDocument('partners', targetMember.id);
            const partnerId = partnerData?.partnerId;
            const partnerMember = partnerId ? await guild.members.fetch(partnerId).catch(() => null) : null;
            const membersToProcess = [targetMember];
            if (partnerMember) membersToProcess.push(partnerMember);

            // Vacate current ship without moving to a new one
            await executePlayerMove(targetMember, null, 'loud');

            const deadPlayersCategory = guild.channels.cache.find(c => c.name === '💀 DEAD PLAYERS' && c.type === ChannelType.GuildCategory);

            for (const member of membersToProcess) {
                // Role management
                if (thrivingRole) await member.roles.remove(thrivingRole).catch(console.error);
                if (partnerRole) await member.roles.remove(partnerRole).catch(console.error);
                await member.roles.add(deadRole).catch(console.error);

                // OPTIMIZED: Find all channels where the member has specific permissions and remove them.
                const permissionRemovalPromises = [];
                guild.channels.cache.forEach(channel => {
                    if (channel.permissionOverwrites.cache.has(member.id)) {
                        permissionRemovalPromises.push(channel.permissionOverwrites.delete(member.id, 'Player died').catch(console.error));
                    }
                });
                await Promise.all(permissionRemovalPromises);
            }

            // Move player's role channel
            const playerRoleChannel = await getPlayerRoleChannel(guild, targetMember);
            if (playerRoleChannel && deadPlayersCategory) {
                await playerRoleChannel.setParent(deadPlayersCategory.id, { lockPermissions: false }).catch(console.error);
            }

            // Clear game state data from Firestore
            await deleteDocument('initialAssignments', targetMember.id);
            await deleteDocument('partners', targetMember.id);
            // Note: We keep player doc for potential revival

            await message.channel.send(`💀 ${targetMember.displayName} and their partner (if any) have officially been marked as dead.`);

        } catch (error) {
            console.error('Error in .dead command:', error);
            await message.channel.send('An error occurred while processing the command. Please check my permissions (`Manage Roles`, `Manage Channels`).');
        }
    }
    else if (command === 'alive' && isAdmin) {
        const targetMember = message.mentions.members.first();
        if (!targetMember) {
            return message.reply(`Please mention a player to revive. Syntax: \`${PREFIX}alive @player\``);
        }
        await message.reply(`✨ Processing revival for ${targetMember.displayName}...`);

        try {
            const thrivingRole = guild.roles.cache.find(r => r.name === 'Thriving');
            const deadRole = guild.roles.cache.find(r => r.name === 'Dead');
            if (!thrivingRole || !deadRole) return message.reply("Thriving or Dead role not found.");

            if (!targetMember.roles.cache.has(deadRole.id)) {
                return message.reply(`${targetMember.displayName} is not dead.`);
            }

            // Role Management
            await targetMember.roles.remove(deadRole);
            await targetMember.roles.add(thrivingRole);

            // Move role channel back
            const roleChannelsCategory = guild.channels.cache.find(c => c.name === 'ROLE CHANNELS' && c.type === ChannelType.GuildCategory);
            const playerRoleChannel = await getPlayerRoleChannel(guild, targetMember);
            if (playerRoleChannel && roleChannelsCategory) {
                await playerRoleChannel.setParent(roleChannelsCategory.id, { lockPermissions: false });
            }

            const availableShips = await getAvailableShips(guild);
            const newHomeShip = availableShips.length > 0 ? availableShips[0] : null;

            if (!newHomeShip) {
                return message.channel.send(`Could not find an available spaceship for ${targetMember.displayName}. Revival failed.`);
            }

            // Assign and move to new ship
            await setDocument('initialAssignments', targetMember.id, { shipId: newHomeShip.id });
            await executePlayerMove(targetMember, newHomeShip, 'loud');

            await message.channel.send(`✅ ${targetMember.displayName} has been revived and assigned to a new home, **${newHomeShip.name}**!`);

        } catch (error) {
            console.error('Error in .alive command:', error);
            await message.channel.send('An error occurred while processing the command.');
        }
    }

    else if (command === 'deleteprofile' && isAdmin) {
        const targetMember = message.mentions.members.first();
        if (!targetMember) {
            return message.reply(`Syntax: \`${PREFIX}deleteprofile @player\``);
        }

        await message.reply(`🔥 Deleting all profile data for **${targetMember.displayName}**...`);

        try {
            // Remove roles
            const thrivingRole = guild.roles.cache.find(r => r.name === 'Thriving');
            const partnerRole = guild.roles.cache.find(r => r.name === 'Partner');
            if (thrivingRole) await targetMember.roles.remove(thrivingRole).catch(console.error);
            if (partnerRole) await targetMember.roles.remove(partnerRole).catch(console.error);

            // Remove player from their current ship
            await executePlayerMove(targetMember, null, 'loud');

            // Delete player's role channel
            const playerRoleChannel = await getPlayerRoleChannel(guild, targetMember);
            if (playerRoleChannel) {
                await playerRoleChannel.delete('Player profile deleted').catch(console.error);
            }

            // Delete all associated data from Firestore
            const collectionsToDeleteFrom = ['players', 'initialAssignments', 'partners', 'presets', 'actionLogs', 'playerSpecialVisits'];
            const deletionPromises = collectionsToDeleteFrom.map(collectionName =>
                deleteDocument(collectionName, targetMember.id)
            );
            await Promise.all(deletionPromises);

            await message.channel.send(`✅ Successfully deleted all data for **${targetMember.displayName}**.`);

        } catch (error) {
            console.error('Error in .deleteprofile command:', error);
            await message.channel.send('An error occurred while deleting the profile. Please check the logs.');
        }
    }
    else if (command === 'public' && isAdmin) {
        if (!message.channel.name.startsWith('spaceship-')) {
            return message.reply('This command can only be used inside a spaceship channel.');
        }

        const thrivingRole = guild.roles.cache.find(r => r.name === 'Thriving');
        const partnerRole = guild.roles.cache.find(r => r.name === 'Partner');
        const challengerRole = guild.roles.cache.find(r => r.name === 'Challenger');

        if (!thrivingRole || !partnerRole) {
            return message.reply('The "Thriving" and/or "Partner" roles could not be found.');
        }

        try {
            await message.channel.permissionOverwrites.edit(thrivingRole.id, {
                ViewChannel: true,
                SendMessages: false,
                AddReactions: false
            });
            await message.channel.permissionOverwrites.edit(partnerRole.id, {
                ViewChannel: true,
                SendMessages: false,
                AddReactions: false
            });
            const pingText = `${thrivingRole || ''} ${partnerRole || ''} ${challengerRole || ''}`;
            await message.reply(`${pingText} The Spaceship is now Public`);
        } catch (error) {
            console.error('Error in .public command:', error);
            await message.channel.send('An error occurred while setting permissions. Please check my `Manage Channels` permission.');
        }
    }
    else if (command === 'setknocktimer' && isAdmin) {
        const minutes = parseInt(args[0]);
        if (isNaN(minutes) || minutes < 0) {
            return message.reply(`Invalid syntax. Please provide a positive number of minutes. Usage: \`${PREFIX}setknocktimer <minutes>\``);
        }

        await updateGameState({ knockTimeout: minutes * 60 * 1000 });
        await message.reply(`⏰ The auto-open timer for knocks has been set to **${minutes}** minute(s).`);
    }
    else if (command === 'setwhisperlimit' && isAdmin) {
        const limit = parseInt(args[0]);
        if (isNaN(limit) || limit < 0) {
            return message.reply(`Invalid syntax. Please provide a positive number for the word limit. Usage: \`${PREFIX}setwhisperlimit <number>\``);
        }
        await updateGameState({ whisperWordLimit: limit });
        await message.reply(`🤫 The word limit for whispers has been set to **${limit}** words.`);
    }
    else if (command === 'night' && isAdmin) {
        await updateGameState({ isNight: true, visitsAllowed: false });
        await setDaytimePermissions(guild, false);

        // Refresh special counts for all players
        const playersSnapshot = await getDocs(collection(db, 'players'));
        const batch = writeBatch(db);
        playersSnapshot.forEach(playerDoc => {
            const playerData = playerDoc.data();
            playerData.profile.specialCount = 2;
            batch.set(playerDoc.ref, { profile: playerData.profile }, { merge: true });
        });
        await batch.commit();

        // Clear special visits records
        await clearCollection('playerSpecialVisits');

        await resetAllVotingSessions(guild);
        await message.channel.send('🌙 **Night has fallen.** All voting has ended. The thriving players can no longer speak in the daytime channels. Special visit counts have been refreshed.\nVisits are now **LOCKED**. Use `.allowvisits` to enable them.');
    }
    else if (command === 'day' && isAdmin) {
        await updateGameState({ isNight: false, visitsAllowed: false });
        await setDaytimePermissions(guild, true);
        await message.channel.send('☀️ **The sun has risen.** The thriving players may now speak in the daytime channels. The `.visitspecial` command is now disabled.\nVisits are now **LOCKED**. Use `.allowvisits` to enable them.');
    }
    else if (command === 'allowvisits' && isAdmin) {
        await updateGameState({ visitsAllowed: true });
        await message.channel.send('✅ Visits are now **ALLOWED** for the current phase.');
    }
    else if (['sls', 'blackhole', 'cygnus', 'la'].includes(command) && isAdmin) {
        const locationMap = {
            sls: { name: 'St. Lazarus Spire', id: 'sls' },
            blackhole: { name: 'Black Hole', id: 'blackhole' },
            cygnus: { name: 'Cygnus Exchange', id: 'cygnus' },
            la: { name: 'La Famiglia Galattica', id: 'laFamiglia' }
        };
        const loc = locationMap[command];
        const subcommand = args.shift()?.toLowerCase();

        if (subcommand === 'head') {
            const targetMember = message.mentions.members.first();
            if (!targetMember) return message.reply(`Syntax: \`${PREFIX}${command} head @player\``);
            await setDocument('specialLocations', loc.id, { head: targetMember.id });
            return message.reply(`✅ **${targetMember.displayName}** has been assigned as the head of ${loc.name}.`);
        }

        if (subcommand === 'maxallow') {
            const max = parseInt(args[0]);
            if (isNaN(max) || max < 0) return message.reply(`Syntax: \`${PREFIX}${command} maxallow <number>\``);
            await setDocument('specialLocations', loc.id, { maxAllowed: max });
            return message.reply(`✅ ${loc.name} will now allow a maximum of **${max}** visitors.`);
        }
        if (subcommand === 'time') {
            const seconds = parseInt(args[0]);
            if (isNaN(seconds) || seconds < 0) return message.reply(`Syntax: \`${PREFIX}${command} time <seconds>\``);
            await setDocument('specialLocations', loc.id, { lobbyTimeoutSeconds: seconds });
            return message.reply(`✅ The lobby timeout for ${loc.name} has been set to **${seconds}** seconds.`);
        }
        return message.reply(`Invalid subcommand. Use \`head\`, \`maxallow\`, or \`time\`.`);
    }
    else if (command === 'visitspecial') {
        if (!isPlayer && !isAdmin) {
            return message.reply('You must have the "Thriving" role to use this command.');
        }
        if (!isAllowedInRoleChannel(message, isAdmin, isAlt)) return;
        const gameState = await getGameState();
        if (!gameState.isNight) {
            return message.reply('This command can only be used at night.');
        }

        const locationId = parseInt(args[0]);
        if (isNaN(locationId) || locationId < 1 || locationId > 4) {
            return message.reply(`Invalid location number. Please choose between 1 and 4.`);
        }

        const specialLocations = {
            1: { name: 'St. Lazarus Spire', id: 'sls' },
            2: { name: 'Black Hole', id: 'blackhole' },
            3: { name: 'Cygnus Exchange', id: 'cygnus' },
            4: { name: 'La Famiglia Galattica', id: 'laFamiglia' }
        };
        const locInfo = specialLocations[locationId];
        const locationName = locInfo.name;
        const formattedLocationName = locationName.toLowerCase().replace(/ /g, '-').replace(/[^\w-]+/g, '');

        const specialLocationCategory = guild.channels.cache.find(c => c.name === 'SPECIAL LOCATION');
        if (!specialLocationCategory) return message.reply("The SPECIAL LOCATION category could not be found.");

        const targetChannel = guild.channels.cache.find(c => c.name === formattedLocationName && c.parentId === specialLocationCategory.id);
        if (!targetChannel) return message.reply(`The channel for "${locationName}" could not be found.`);

        try {
            await targetChannel.permissionOverwrites.create(message.author.id, { ViewChannel: true });

            const rowEnter = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`special-enter_${locationId}_${message.author.id}`)
                    .setLabel(`Enter ${locationName}`)
                    .setStyle(ButtonStyle.Primary)
            );
            const rowLeave = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`special-location-leave_${locationId}_${message.author.id}`)
                    .setLabel(`Leave Channel`)
                    .setStyle(ButtonStyle.Danger)
            );

            const sentMessage = await targetChannel.send({
                content: `Welcome, ${message.member}. Would you like to enter?`,
                components: [rowEnter, rowLeave]
            });

            const locData = await getDocument('specialLocations', locInfo.id);
            const timeoutSeconds = locData?.lobbyTimeoutSeconds || 3600; // Default 1 hour
            const expiryTimestamp = Date.now() + (timeoutSeconds * 1000);

            await setDocument('specialLocationLobbies', message.author.id, {
                channelId: targetChannel.id,
                messageId: sentMessage.id,
                expiryTimestamp: expiryTimestamp,
                guildId: guild.id
            });

            await message.reply({ content: `You have been granted access to ${targetChannel.toString()}. Please make your decision there within ${timeoutSeconds / 60} minutes.`, ephemeral: true });

        } catch (error) {
            console.error("Error in .visitspecial command:", error);
            await message.reply("An error occurred while trying to grant you access.");
        }
    }
    else if (command === 'visit') {
        if (!isPlayer && !isAlt && !isAdmin) {
            return message.reply('You must have the "Thriving" or "Alt" role to use this command.');
        }
        if (!isAllowedInRoleChannel(message, isAdmin, isAlt)) return;
        const gameState = await getGameState();
        if (gameState.visitBlockedPlayers.includes(message.author.id)) {
            return message.reply({ content: 'You are currently visit-blocked by an admin and cannot move.', ephemeral: true });
        }
        if (!gameState.visitsAllowed) {
            return message.reply({ content: 'Visits are currently locked by the game master. Please wait for them to be enabled.', ephemeral: true });
        }

        const visitType = args.shift()?.toLowerCase();
        const shipNumberStr = args.join(' ');

        if (!['regular', 'special', 'stealth'].includes(visitType) || !shipNumberStr || isNaN(parseInt(shipNumberStr))) {
            return message.reply(`Invalid syntax. Use: \`${PREFIX}visit <type> <ship-number>\``);
        }

        const shipNumber = parseInt(shipNumberStr);
        const playerData = await getDocument('players', message.author.id);
        if (!playerData || !playerData.profile) {
            return message.reply({ content: "I can't find your player profile.", ephemeral: true });
        }
        const profile = playerData.profile;

        const timeOfDay = gameState.isNight ? 'night' : 'day';
        if (profile.visits[timeOfDay][visitType] <= 0) {
            return message.reply(`You have no **${timeOfDay} ${visitType}** visits left.`);
        }

        const targetShip = guild.channels.cache.find(c => c.name === `spaceship-${shipNumber}` && c.type === ChannelType.GuildText);
        if (!targetShip) {
            return message.reply(`Could not find a spaceship with the number \`${shipNumber}\`.`);
        }

        const shipMods = await getDocument('shipModifiers', targetShip.id);
        let effectiveVisitType = visitType;
        if (shipMods) {
            if (effectiveVisitType === 'special' && shipMods.specialToRegular) effectiveVisitType = 'regular';
            if (effectiveVisitType === 'stealth' && shipMods.stealthToRegular) effectiveVisitType = 'regular';
        }

        const currentAssignment = await getDocument('shipAssignments', targetShip.id);
        const occupants = currentAssignment?.occupants || []; 

        if (occupants.includes(message.author.id)) {
            return message.reply("You are already in that spaceship.");
        }

        // Decrement visit count and save back to Firestore
        profile.visits[timeOfDay][visitType]--;
        await setDocument('players', message.author.id, { profile });

        if (effectiveVisitType === 'special' || effectiveVisitType === 'stealth') {
            const narration = (effectiveVisitType === 'special') ? 'loud' : 'stealth';
            await executePlayerMove(message.member, targetShip, narration);
            const replyMsg = (narration === 'loud')
                ? `You used a **special visit** and moved to **${targetShip.name}**.`
                : `You used a **stealth visit** and silently moved to **${targetShip.name}**.`;
            await message.reply(replyMsg);
            return;
        }

        if (effectiveVisitType === 'regular') {
            if (shipMods?.doorDestroyed) {
                await executePlayerMove(message.member, targetShip, 'loud');
                await message.reply(`You used a **regular visit** on **${targetShip.name}**. Its door was destroyed, so you entered freely.`);
                return;
            }

            if (occupants.length > 0) {
                const thrivingRole = guild.roles.cache.find(r => r.name === 'Thriving');
                const partnerRole = guild.roles.cache.find(r => r.name === 'Partner');
                const challengerRole = guild.roles.cache.find(r => r.name === 'Challenger');
                const pingText = `${thrivingRole || ''} ${partnerRole || ''} ${challengerRole || ''}`;

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`visit-open_${message.author.id}_${targetShip.id}`).setLabel('Open Door').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`visit-deny_${message.author.id}_${targetShip.id}`).setLabel('Deny Entry').setStyle(ButtonStyle.Danger),
                );
                const knockMessage = await targetShip.send({ content: `${pingText}\n🚪 Someone is knocking on the door. Will you let them in?`, components: [row] });
                await message.reply(`You used a **regular visit** to knock on **${targetShip.name}**. Awaiting a response.`);

                setTimeout(async () => {
                    const currentMessage = await targetShip.messages.fetch(knockMessage.id).catch(() => null);
                    if (!currentMessage || currentMessage.components.length === 0) return;

                    const visitor = await guild.members.fetch(message.author.id).catch(() => null);
                    if (!visitor) {
                        await currentMessage.edit({ content: 'The knock timed out, but the visitor could not be found.', components: [] });
                        return;
                    }

                    await executePlayerMove(visitor, targetShip, 'loud');
                    await currentMessage.edit({ content: `The door was opened automatically as the knock was not answered in time.`, components: [] });

                    const visitorRoleChannel = await getPlayerRoleChannel(guild, visitor);
                    if (visitorRoleChannel) {
                        await visitorRoleChannel.send(`✅ Your knock on **${targetShip.name}** timed out and the door opened automatically.`);
                    }
                }, gameState.knockTimeout);

            } else {
                await executePlayerMove(message.member, targetShip, 'loud');
                await message.reply(`You used a **regular visit** on **${targetShip.name}**. It was empty, so you entered freely.`);
            }
        }
    }
    else if (command === 'preset') {
        if (!isPlayer && !isAdmin) {
            return message.reply('You must have the "Thriving" role to use this command.');
        }
        if (!isAllowedInRoleChannel(message, isAdmin, isAlt)) return;

        const [abilityCode, ...targetArgs] = args;
        const targetInput = targetArgs.join(' ');

        if (!abilityCode || !targetInput) {
            return message.reply(`Syntax: \`${PREFIX}preset <ability code> <target>\`.\nExample: \`${PREFIX}preset s1 @PlayerName\` or \`${PREFIX}preset s1 #spaceship-12\`.\nUse \`.profile\` to see your ability codes.`);
        }

        const playerData = await getDocument('players', message.author.id);
        if (!playerData || !playerData.profile) {
            return message.reply({ content: "I can't find your player profile.", ephemeral: true });
        }
        const profile = playerData.profile;

        const match = abilityCode.toLowerCase().match(/^(s|i)(\d+)$/);
        if (!match) {
            return message.reply(`Invalid ability code format. Use codes like \`s1\`, \`i1\`, etc., as shown in your profile.`);
        }

        const type = match[1];
        const index = parseInt(match[2], 10) - 1;

        if (type !== 's') {
            return message.reply('You can only preset **Superpowers**.');
        }

        const sortedActiveAbilities = [...profile.abilities.active].sort((x, y) => x.priority - y.priority);

        if (index < 0 || index >= sortedActiveAbilities.length) {
            return message.reply(`Invalid ability code. You don't have an ability with the code \`${abilityCode.toUpperCase()}\`.`);
        }

        const selectedAbility = sortedActiveAbilities[index];
        let targetName = 'Unknown';
        let targetId = null;

        const mentionedMember = message.mentions.members.first();
        const mentionedChannel = message.mentions.channels.first();

        if (mentionedMember) {
            targetName = mentionedMember.displayName;
            targetId = mentionedMember.id;
        } else if (mentionedChannel) {
            if (!mentionedChannel.name.startsWith('spaceship-')) {
                return message.reply('You can only target players or spaceship channels.');
            }
            targetName = `#${mentionedChannel.name}`;
            targetId = mentionedChannel.id;
        } else {
            targetName = targetInput;
            targetId = targetInput;
        }

        const playerPresetsData = await getDocument('presets', message.author.id) || { presets: {} };
        const playerPresets = playerPresetsData.presets;

        playerPresets[abilityCode.toLowerCase()] = {
            priority: selectedAbility.priority,
            description: selectedAbility.description,
            category: selectedAbility.category,
            targetName: targetName,
            targetId: targetId,
            playerName: message.member.displayName,
            playerId: message.author.id,
            abilityCode: abilityCode.toLowerCase()
        };

        await setDocument('presets', message.author.id, { presets: playerPresets });

        const allPlayerPresets = Object.values(playerPresets).sort((a, b) => a.priority - b.priority);
        const presetLines = allPlayerPresets.map(p => {
            return `> \`${p.abilityCode.toUpperCase()}\` **[${p.category}]** ${p.description} ➜ **${p.targetName}**`;
        });

        const confirmationEmbed = new EmbedBuilder()
            .setColor('Green')
            .setTitle('Your Action Presets')
            .setDescription(presetLines.join('\n'))
            .setFooter({ text: 'Use the command again with the same ability code to change its target.' });

        await message.reply({ embeds: [confirmationEmbed] });
    }
    else if (command === 'action') {
        if (!isPlayer && !isAdmin) {
            return message.reply('You must have the "Thriving" role to use this command.');
        }
        if (!isAllowedInRoleChannel(message, isAdmin, isAlt)) return;

        const abilityCode = args[0];
        const descriptionMatch = message.content.match(/"(.*?)"/);
        const description = descriptionMatch ? descriptionMatch[1] : null;

        if (!abilityCode || !description) {
            return message.reply(`Syntax: \`${PREFIX}action <ability-code> "description"\`\nExample: \`${PREFIX}action s1 "Using my ability on Player X."\``);
        }

        const playerActionLogsData = await getDocument('actionLogs', message.author.id) || { logs: [] };
        const playerActionLogs = playerActionLogsData.logs;

        const logEntry = `**${abilityCode.toUpperCase()}**: ${description}`;
        const timestamp = new Date();

        playerActionLogs.push({ log: logEntry, timestamp: timestamp.toISOString() });
        await setDocument('actionLogs', message.author.id, { logs: playerActionLogs });

        const overseerCategory = guild.channels.cache.find(c => c.name === '👁️ OVERSEER');
        const actionsChannel = overseerCategory
            ? guild.channels.cache.find(c => c.parentId === overseerCategory.id && c.name.endsWith('actions'))
            : null;

        if (actionsChannel) {
            const discordTimestamp = `<t:${Math.floor(timestamp.getTime() / 1000)}:F>`;
            const logEmbed = new EmbedBuilder()
                .setColor('Blue')
                .setAuthor({ name: `${message.member.displayName}'s Action`, iconURL: message.member.displayAvatarURL() })
                .setDescription(`${logEntry}\n\n**Logged at:** ${discordTimestamp}`)
                .setTimestamp(timestamp);
            await actionsChannel.send({ embeds: [logEmbed] });
            await message.reply({ content: `Your action has been logged successfully.`, ephemeral: true });

        } else {
            await message.reply({ content: 'Your action has been logged internally, but the actions channel (엑 actions) could not be found.', ephemeral: true });
        }
    }
    else if (command === 'actions' && isAdmin) {
        const targetMember = message.mentions.members.first();
        if (!targetMember) {
            return message.reply(`Syntax: \`${PREFIX}actions @player [subcommand]\``);
        }

        const subcommand = args[1]?.toLowerCase();
        const playerActionLogsData = await getDocument('actionLogs', targetMember.id) || { logs: [] };
        let playerActionLogs = playerActionLogsData.logs;

        if (!subcommand) { // List actions
            if (playerActionLogs.length === 0) {
                return message.reply(`**${targetMember.displayName}** has no logged actions.`);
            }
            const description = playerActionLogs.map((entry, index) => {
                const discordTimestamp = `<t:${Math.floor(new Date(entry.timestamp).getTime() / 1000)}:F>`;
                return `**${index + 1}.** ${discordTimestamp}\n> ${entry.log}`;
            }).join('\n\n');

            const listEmbed = new EmbedBuilder()
                .setColor('Greyple')
                .setTitle(`${targetMember.displayName}'s Action Log`)
                .setDescription(description.substring(0, 4096));
            return message.channel.send({ embeds: [listEmbed] });
        }

        if (subcommand === 'delete') {
            const index = parseInt(args[2]);
            if (isNaN(index) || index < 1 || index > playerActionLogs.length) {
                return message.reply(`Invalid index. Please provide a number between 1 and ${playerActionLogs.length}.`);
            }
            const [deletedAction] = playerActionLogs.splice(index - 1, 1);
            await setDocument('actionLogs', targetMember.id, { logs: playerActionLogs });
            return message.reply(`✅ Deleted action #${index} for **${targetMember.displayName}**:\n> ${deletedAction.log}`);
        }

        if (subcommand === 'add') {
            const indexStr = args[2];
            const descriptionMatch = message.content.match(/"(.*?)"/);
            const description = descriptionMatch ? descriptionMatch[1] : null;

            if (!indexStr || isNaN(parseInt(indexStr)) || !description) {
                return message.reply(`Syntax: \`${PREFIX}actions @player add <index> "description"\``);
            }
            const index = parseInt(indexStr);

            if (index < 1 || index > playerActionLogs.length + 1) {
                return message.reply(`Invalid index. Please provide a number between 1 and ${playerActionLogs.length + 1}.`);
            }
            const newLogEntry = { log: description, timestamp: new Date().toISOString() };
            playerActionLogs.splice(index - 1, 0, newLogEntry); // Insert at index
            await setDocument('actionLogs', targetMember.id, { logs: playerActionLogs });
            return message.reply(`✅ Added new action at position #${index} in **${targetMember.displayName}**'s log.`);
        }

        return message.reply(`Invalid subcommand. Use \`delete\` or \`add\`.`);
    }
    else if (command === 'vote') {
        const mentionedChannel = message.mentions.channels.first();
        const mentionedMember = message.mentions.members.first();

        if (isAdmin && mentionedChannel) {
            if (!mentionedChannel.name.startsWith('voting-channel')) {
                return message.reply('You can only start a vote in a `#voting-channel-x` channel.');
            }
            const existingSession = await getDocument('votingSessions', mentionedChannel.id);
            if (existingSession) {
                return message.reply(`A voting session is already active in ${mentionedChannel.toString()}. Use \`.votereset ${mentionedChannel.toString()}\` to stop it first.`);
            }
            await setDocument('votingSessions', mentionedChannel.id, { votes: {}, playerVotes: {}, voteCountMessageId: null });
            await message.channel.send(`📣 **Voting has officially started in ${mentionedChannel.toString()}!**`);
            await updateVoteCount(mentionedChannel);
            return;
        }

        if ((isPlayer || isAdmin) && mentionedMember) {
            // UPDATED LOGIC: Removed the isAllowedInRoleChannel check.
            const currentSession = await getDocument('votingSessions', message.channel.id);
            if (!currentSession) {
                return message.reply({ content: 'There is no active voting session in this channel right now.', ephemeral: true });
            }

            if (!mentionedMember.roles.cache.some(r => r.name === 'Thriving')) {
                return message.reply({ content: 'You can only vote for players who are currently "Thriving".', ephemeral: true });
            }

            const voterId = message.author.id;
            const targetId = mentionedMember.id;
            const playerVotes = currentSession.playerVotes || {};
            const votes = currentSession.votes || {};

            if (playerVotes[voterId]) {
                const oldTargetId = playerVotes[voterId];
                if (oldTargetId === targetId) {
                    return message.reply({ content: `You are already voting for ${mentionedMember.displayName}.`, ephemeral: true });
                }
                if (votes[oldTargetId]) {
                    votes[oldTargetId] = votes[oldTargetId].filter(id => id !== voterId);
                }
            }

            if (!votes[targetId]) {
                votes[targetId] = [];
            }
            votes[targetId].push(voterId);
            playerVotes[voterId] = targetId;

            await setDocument('votingSessions', message.channel.id, { votes, playerVotes });

            message.react('✅').catch(console.error);
            await updateVoteCount(message.channel);
            return;
        }

        return message.reply(`Invalid syntax. \n**Admin:** \`${PREFIX}vote #channel-name\`\n**Player:** \`${PREFIX}vote @player-name\``);
    }
    else if (command === 'manipulate' && isAdmin) {
        const mentionedMembers = message.mentions.members;
        if (mentionedMembers.size < 1 || mentionedMembers.size > 2) {
            return message.reply(`Invalid syntax. Please mention one or two players: \`${PREFIX}manipulate @voter [@target]\``);
        }

        let voter, target;
        if (mentionedMembers.size === 1) {
            voter = target = mentionedMembers.first();
        } else {
            [voter, target] = mentionedMembers.values();
        }

        if (!voter.roles.cache.some(r => r.name === 'Thriving') || !target.roles.cache.some(r => r.name === 'Thriving')) {
            return message.reply('Both players involved in a manipulation must have the "Thriving" role.');
        }

        const currentSession = await getDocument('votingSessions', message.channel.id);
        if (!currentSession) {
            return message.reply('There is no active voting session in this channel to manipulate.');
        }

        const voterId = voter.id;
        const targetId = target.id;
        const playerVotes = currentSession.playerVotes || {};
        const votes = currentSession.votes || {};

        if (playerVotes[voterId]) {
            const oldTargetId = playerVotes[voterId];
            if (votes[oldTargetId]) {
                votes[oldTargetId] = votes[oldTargetId].filter(id => id !== voterId);
            }
        }

        if (!votes[targetId]) {
            votes[targetId] = [];
        }
        votes[targetId].push(voterId);
        playerVotes[voterId] = targetId;

        await setDocument('votingSessions', message.channel.id, { votes, playerVotes });

        await updateVoteCount(message.channel);
        const confirmationText = voter.id === target.id
            ? `✅ Manipulated **${voter.displayName}** to vote for **themselves**.`
            : `✅ Manipulated **${voter.displayName}** to vote for **${target.displayName}**.`;
        await message.channel.send(confirmationText);
    }
    else if (command === 'allpresets' && isAdmin) {
        const presetsSnapshot = await getDocs(collection(db, 'presets'));
        if (presetsSnapshot.empty) {
            return message.reply('No players have submitted a preset action yet.');
        }

        const allPresetsList = presetsSnapshot.docs.flatMap(doc => Object.values(doc.data().presets));

        if (allPresetsList.length === 0) {
            return message.reply('No players have submitted a preset action yet.');
        }

        allPresetsList.sort((a, b) => a.priority - b.priority);

        const descriptionLines = allPresetsList.map(p => {
            let finalTargetName = p.targetName;
            const targetMember = guild.members.cache.get(p.targetId);
            if (targetMember) {
                finalTargetName = targetMember.displayName;
            }
            return `**P${p.priority} - ${p.playerName}**: [${p.category}] ${p.description} ➜ **${finalTargetName}**`;
        });

        const embed = new EmbedBuilder()
            .setColor('Gold')
            .setTitle(`All Submitted Player Presets (${allPresetsList.length})`)
            .setDescription(descriptionLines.join('\n').substring(0, 4096))
            .setFooter({ text: 'Sorted by ascending priority (lowest first).' })
            .setTimestamp();

        await message.channel.send({ embeds: [embed] });
    }
    else if (command === 'votereset' && isAdmin) {
        const targetChannel = message.mentions.channels.first();
        const voteCountChannel = guild.channels.cache.find(c => c.name === 'voting-count');

        if (targetChannel) {
            const session = await getDocument('votingSessions', targetChannel.id);
            if (session) {
                if (session.voteCountMessageId && voteCountChannel) {
                    await voteCountChannel.messages.delete(session.voteCountMessageId).catch(err => console.error(`Could not delete tally message for ${targetChannel.name}:`, err));
                }
                await deleteDocument('votingSessions', targetChannel.id);
                await message.reply(`Voting session in ${targetChannel.toString()} has been reset.`);
            } else {
                await message.reply(`There was no active voting session in ${targetChannel.toString()} to reset.`);
            }
        } else {
            await resetAllVotingSessions(guild);
            await message.reply('All active voting sessions have been reset.');
        }
    }
    else if (command === 'h4n30b4m1l20g94' && isAdmin) { //secret reset command , secreto 
        await message.reply('**DANGER:** This will delete all game-related channels and roles, and wipe the database. Are you sure? Type `yes` to confirm within 15 seconds.');
        const filter = m => m.author.id === message.author.id && m.content.toLowerCase() === 'yes';
        const collector = message.channel.createMessageCollector({ filter, time: 15000, max: 1 });

        collector.on('collect', async m => {
            await resetFullGameState();
            await m.reply('🔥 **Resetting the entire game world...**');
            try {
                const categoriesToDelete = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto', 'ROLE CHANNELS', 'ALTS ROLE CHANNELS', 'DAYTIME', 'PUBLIC CHANNELS', 'PRIVATE CHANNELS', 'SPECIAL LOCATION', 'TALKING', 'destroyed-spaceships', '👁️ OVERSEER', '⚙️ TECHNICAL STUFF', '💀 DEAD PLAYERS', 'WAITING ROLE CHANNELS', 'CLOSED PUBLIC CHANNELS', 'CLOSED PRIVATE CHANNELS', 'CLOSED SPECIAL CHANNELS'];
                for (const catName of categoriesToDelete) {
                    const category = guild.channels.cache.find(c => c.name === catName && c.type === ChannelType.GuildCategory);
                    if (category) {
                        const children = guild.channels.cache.filter(c => c.parentId === category.id);
                        for (const child of children.values()) {
                            await child.delete('Game reset').catch(e => console.error(`Could not delete channel ${child.name}: ${e.message}`));
                        }
                        await category.delete('Game reset').catch(e => console.error(`Could not delete category ${category.name}: ${e.message}`));
                    }
                }
                const rolesToDelete = ['Thriving', 'Traitor', 'Ghost', 'Dead', 'Partner', 'Challenger', 'Overseer', 'Spectator', 'Alt'];
                for (const roleName of rolesToDelete) {
                    const role = guild.roles.cache.find(r => r.name === roleName);
                    if (role) await role.delete('Game reset').catch(e => console.error(`Could not delete role ${role.name}: ${e.message}`));
                }
                await m.channel.send('✅ **Reset complete.**');
            } catch (error) {
                console.error("Error during reset:", error);
                await m.channel.send("❌ An error occurred during reset. I might be missing permissions.");
            }
        });

        collector.on('end', collected => {
            if (collected.size === 0) message.reply('Reset cancelled.');
        });
    }
    else if (command === 'destroy' && isAdmin) {
        let targetShip = message.mentions.channels.first();
        if (!targetShip) {
            const shipName = args.find(arg => arg.startsWith('spaceship-'));
            if (shipName) {
                targetShip = guild.channels.cache.find(c => c.name === shipName && c.type === ChannelType.GuildText);
            }
        }

        if (!targetShip || !targetShip.name.startsWith('spaceship-')) {
            return message.reply(`Invalid syntax or spaceship not found. Use: \`${PREFIX}destroy #spaceship-channel\``);
        }

        let destroyedCategory = guild.channels.cache.find(c => c.name === 'destroyed-spaceships' && c.type === ChannelType.GuildCategory);
        if (!destroyedCategory) {
            destroyedCategory = await guild.channels.create({
                name: 'destroyed-spaceships',
                type: ChannelType.GuildCategory,
                permissionOverwrites: [{ id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] }]
            });
        }

        await setDocument('destroyedShipOrigins', targetShip.id, { originParentId: targetShip.parentId });
        await targetShip.setParent(destroyedCategory.id, { lockPermissions: true });

        const announcementChannel = guild.channels.cache.find(c => c.name === 'announcement');
        const thrivingRole = guild.roles.cache.find(r => r.name === 'Thriving');
        const partnerRole = guild.roles.cache.find(r => r.name === 'Partner');
        const challengerRole = guild.roles.cache.find(r => r.name === 'Challenger');
        const pingText = `${thrivingRole || ''} ${partnerRole || ''} ${challengerRole || ''}`;

        announcementChannel?.send(`${pingText}\n💥 **${targetShip.name}** has been destroyed!`);

        const initialAssignmentsSnapshot = await getDocs(collection(db, 'initialAssignments'));
        for (const doc of initialAssignmentsSnapshot.docs) {
            if (doc.data().shipId === targetShip.id) {
                const member = await guild.members.fetch(doc.id).catch(() => null);
                const roleChannel = await getPlayerRoleChannel(guild, member);
                roleChannel?.send(`🚨 Your home ship, **${targetShip.name}**, has been destroyed! You are now homeless. Find a new spaceship before the phase ends or you might die!`);
                await deleteDocument('initialAssignments', doc.id);
            }
        }

        await message.reply(`✅ Successfully moved **${targetShip.name}** to the destroyed category.`);
    }
    else if (command === 'revive' && isAdmin) {
        let targetShip = message.mentions.channels.first();
        if (!targetShip) {
            const shipName = args.find(arg => arg.startsWith('spaceship-'));
            if (shipName) {
                targetShip = guild.channels.cache.find(c => c.name === shipName && c.parent?.name === 'destroyed-spaceships');
            }
        }

        if (!targetShip || targetShip.parent?.name !== 'destroyed-spaceships') {
            return message.reply(`Invalid syntax or ship is not destroyed. Use: \`${PREFIX}revive #spaceship-channel\``);
        }

        const originData = await getDocument('destroyedShipOrigins', targetShip.id);
        const originalParentId = originData?.originParentId;
        if (!originalParentId) {
            return message.reply("I don't remember where this ship came from. Cannot revive it.");
        }

        const originalParent = guild.channels.cache.get(originalParentId);
        if (!originalParent) {
            return message.reply("The original planet category for this ship seems to be deleted. Cannot revive it.");
        }

        await targetShip.setParent(originalParent.id, { lockPermissions: false });
        await deleteDocument('destroyedShipOrigins', targetShip.id);

        await message.reply(`✅ Successfully revived **${targetShip.name}** and moved it back to the **${originalParent.name}** system.`);
    }
    else if (command === 'special_to_regular' && isAdmin) {
        let targetShip = message.mentions.channels.first();
        if (!targetShip) {
            const shipName = args.find(arg => arg.startsWith('spaceship-'));
            if (shipName) {
                targetShip = guild.channels.cache.find(c => c.name === shipName && c.type === ChannelType.GuildText);
            }
        }
        const setting = args.find(arg => ['yes', 'no'].includes(arg.toLowerCase()));

        if (!targetShip || !targetShip.name.startsWith('spaceship-') || !setting) {
            return message.reply(`Syntax: \`${PREFIX}special_to_regular #spaceship-channel <yes|no>\``);
        }
        await setDocument('shipModifiers', targetShip.id, { specialToRegular: (setting === 'yes') });
        await message.reply(`✅ Special visits to **${targetShip.name}** will now function as regular visits: **${setting.toUpperCase()}**.`);
    }
    else if (command === 'stealth_to_regular' && isAdmin) {
        let targetShip = message.mentions.channels.first();
        if (!targetShip) {
            const shipName = args.find(arg => arg.startsWith('spaceship-'));
            if (shipName) {
                targetShip = guild.channels.cache.find(c => c.name === shipName && c.type === ChannelType.GuildText);
            }
        }
        const setting = args.find(arg => ['yes', 'no'].includes(arg.toLowerCase()));

        if (!targetShip || !targetShip.name.startsWith('spaceship-') || !setting) {
            return message.reply(`Syntax: \`${PREFIX}stealth_to_regular #spaceship-channel <yes|no>\``);
        }
        await setDocument('shipModifiers', targetShip.id, { stealthToRegular: (setting === 'yes') });
        await message.reply(`✅ Stealth visits to **${targetShip.name}** will now function as regular visits: **${setting.toUpperCase()}**.`);
    }
    else if (command === 'visitblock' && isAdmin) {
        const targetMember = message.mentions.members.first();
        const setting = args.find(arg => ['yes', 'no'].includes(arg.toLowerCase()));
        if (!targetMember || !setting) {
            return message.reply(`Syntax: \`${PREFIX}visitblock @player <yes|no>\``);
        }
        const gameState = await getGameState();
        let blockedPlayers = gameState.visitBlockedPlayers || [];
        if (setting === 'yes') {
            if (!blockedPlayers.includes(targetMember.id)) {
                blockedPlayers.push(targetMember.id);
            }
            await updateGameState({ visitBlockedPlayers: blockedPlayers });
            await message.reply(`✅ **${targetMember.displayName}** is now blocked from using the \`.visit\` command.`);
        } else {
            blockedPlayers = blockedPlayers.filter(id => id !== targetMember.id);
            await updateGameState({ visitBlockedPlayers: blockedPlayers });
            await message.reply(`✅ **${targetMember.displayName}** is no longer visit-blocked.`);
        }
    }
    else if (command === 'destroydoor' && isAdmin) {
        let targetShip = message.mentions.channels.first();
        if (!targetShip) {
            const shipName = args.find(arg => arg.startsWith('spaceship-'));
            if (shipName) {
                targetShip = guild.channels.cache.find(c => c.name === shipName && c.type === ChannelType.GuildText);
            }
        }
        if (!targetShip || !targetShip.name.startsWith('spaceship-')) {
            return message.reply(`Syntax: \`${PREFIX}destroydoor #spaceship-channel\``);
        }
        await setDocument('shipModifiers', targetShip.id, { doorDestroyed: true });
        await message.reply(`✅ The door to **${targetShip.name}** has been destroyed! Regular visits no longer require knocking.`);
    }
    else if (command === 'where' && isAdmin) {
        const targetMember = message.mentions.members.first();
        if (!targetMember) {
            return message.reply(`Syntax: \`${PREFIX}where @player\``);
        }

        const locations = {
            spaceship: [],
            public: [],
            private: [],
            special: []
        };

        // 1. OPTIMIZED: Check current spaceship assignment with a targeted query
        const assignmentsRef = collection(db, 'shipAssignments');
        const q = query(assignmentsRef, where('occupants', 'array-contains', targetMember.id));
        const assignmentsSnapshot = await getDocs(q);

        assignmentsSnapshot.forEach(doc => {
            const shipChannel = guild.channels.cache.get(doc.id);
            if (shipChannel) {
                locations.spaceship.push(shipChannel.toString());
            }
        });


        // 2. Check channel categories by permissions
        const publicCategory = guild.channels.cache.find(c => c.name === 'PUBLIC CHANNELS');
        const privateCategory = guild.channels.cache.find(c => c.name === 'PRIVATE CHANNELS');
        const specialCategory = guild.channels.cache.find(c => c.name === 'SPECIAL LOCATION');

        const categoriesToCheck = [
            { category: publicCategory, key: 'public' },
            { category: privateCategory, key: 'private' },
            { category: specialCategory, key: 'special' }
        ];

        for (const { category, key } of categoriesToCheck) {
            if (category) {
                const channels = guild.channels.cache.filter(c => c.parentId === category.id);
                for (const channel of channels.values()) {
                    const perms = channel.permissionsFor(targetMember);
                    if (perms && perms.has(PermissionsBitField.Flags.ViewChannel)) {
                        locations[key].push(channel.toString());
                    }
                }
            }
        }

        const embed = new EmbedBuilder()
            .setColor('Aqua')
            .setTitle(`📍 ${targetMember.displayName}'s Current Locations`)
            .addFields(
                { name: '🚀 Spaceship', value: locations.spaceship.length > 0 ? locations.spaceship.join('\n') : 'None' },
                { name: '📢 Public Channels', value: locations.public.length > 0 ? locations.public.join('\n') : 'None' },
                { name: '🔒 Private Channels', value: locations.private.length > 0 ? locations.private.join('\n') : 'None' },
                { name: '✨ Special Locations', value: locations.special.length > 0 ? locations.special.join('\n') : 'None' }
            )
            .setTimestamp();

        await message.channel.send({ embeds: [embed] });
    }
    else if (command === 'teleport' && isAdmin) {
        const targetMember = message.mentions.members.first();
        const targetShip = message.mentions.channels.first();

        if (!targetMember || !targetShip || !targetShip.name.startsWith('spaceship-') || targetShip.type !== ChannelType.GuildText) {
            return message.reply(`Invalid syntax or target. Use: \`${PREFIX}teleport @player #spaceship-channel\``);
        }

        const currentAssignment = await getDocument('shipAssignments', targetShip.id);
        if (currentAssignment?.occupants?.includes(targetMember.id)) {
            return message.reply(`**${targetMember.displayName}** is already in **${targetShip.name}**.`);
        }

        try {
            await executePlayerMove(targetMember, targetShip, 'loud');
            await message.reply(`🚀 Teleported **${targetMember.displayName}** to **${targetShip.name}**.`);
        } catch (error) {
            console.error('Error during .teleport command:', error);
            await message.reply('An error occurred while trying to teleport the player.');
        }
    }
    else if (command === 'who' && isAdmin) {
        const targetRole = message.mentions.roles.first();
        if (!targetRole) {
            return message.reply(`Syntax: \`${PREFIX}who @role\``);
        }

        // Fetch all members to ensure the cache is up-to-date
        await message.guild.members.fetch();

        const membersWithRole = targetRole.members;
        if (membersWithRole.size === 0) {
            return message.reply(`No players currently have the **${targetRole.name}** role.`);
        }

        const memberMentions = membersWithRole.map(member => member.toString()).join(', ');
        
        // Send the message, splitting it if it's too long for a single Discord message
        const response = `Players with the **${targetRole.name}** role: ${memberMentions}`;
        if (response.length > 2000) {
            // Split the response into chunks if it exceeds Discord's character limit
            for (let i = 0; i < response.length; i += 2000) {
                const chunk = response.substring(i, i + 2000);
                await message.channel.send(chunk);
            }
        } else {
            await message.channel.send(response);
        }
    }
    else if (command === 'w') {
        if (!isPlayer && !isAdmin) {
            return message.reply('You must have the "Thriving" role to use this command.');
        }

        // Check if the command is used in an allowed channel for players
        if (isPlayer && !isAdmin && !isAllowedInRoleChannel(message, isAdmin, isAlt)) {
            return;
        }

        const thrivingRole = guild.roles.cache.find(r => r.name === 'Thriving');
        if (!thrivingRole) {
            return message.reply('Could not find the "Thriving" role.');
        }

        const thrivingMembers = thrivingRole.members.map(member => member.displayName);
        const thrivingList = thrivingMembers.length > 0 ? thrivingMembers.join(', ') : 'No thriving players found.';

        const thrivingEmbed = new EmbedBuilder()
            .setColor('Aqua')
            .setTitle('List of Thriving Players')
            .setDescription(thrivingList);

        await message.channel.send({ embeds: [thrivingEmbed] });
    }
    // --- NEW: Gem/Shop Admin Commands ---
    else if (command === 'gem-give' && isAdmin) {
        const targetMember = message.mentions.members.first();
        const amount = parseInt(args[1]);
        if (!targetMember || isNaN(amount) || amount <= 0) {
            return message.reply(`Syntax: \`${PREFIX}gem-give @player <amount>\``);
        }
        const playerData = await getDocument('players', targetMember.id) || createDefaultProfile(targetMember);
        const newBal = (playerData.wallet || 0) + amount;
        await setDocument('players', targetMember.id, { wallet: newBal });
        await message.reply(`✅ Gave **${amount}** gems to **${targetMember.displayName}**. Their new balance is ${newBal}.`);
    }
    else if (command === 'gem-take' && isAdmin) {
        const targetMember = message.mentions.members.first();
        const amount = parseInt(args[1]);
        if (!targetMember || isNaN(amount) || amount <= 0) {
            return message.reply(`Syntax: \`${PREFIX}gem-take @player <amount>\``);
        }
        const playerData = await getDocument('players', targetMember.id) || createDefaultProfile(targetMember);
        const newBal = Math.max(0, (playerData.wallet || 0) - amount);
        await setDocument('players', targetMember.id, { wallet: newBal });
        await message.reply(`✅ Took **${amount}** gems from **${targetMember.displayName}**. Their new balance is ${newBal}.`);
    }
    else if (command === 'gem-set' && isAdmin) {
        const targetMember = message.mentions.members.first();
        const amount = parseInt(args[1]);
        if (!targetMember || isNaN(amount) || amount < 0) {
            return message.reply(`Syntax: \`${PREFIX}gem-set @player <amount>\``);
        }
        await setDocument('players', targetMember.id, { wallet: amount, displayName: targetMember.displayName });
        await message.reply(`✅ Set **${targetMember.displayName}**'s gem balance to **${amount}**.`);
    }
    else if (command === 'shop-add' && isAdmin) {
        const itemName = args[0];
        const price = parseInt(args[1]);
        const descriptionMatch = message.content.match(/"(.*?)"/);
        const description = descriptionMatch ? descriptionMatch[1] : null;

        if (!itemName || isNaN(price) || price < 0 || !description) {
            return message.reply(`Syntax: \`${PREFIX}shop-add <itemName> <price> "<description>"\``);
        }
        const key = itemName.toLowerCase();
        const existingItem = await getDocument('shopItems', key);
        if (existingItem) {
            return message.reply(`An item named "${itemName}" already exists in the shop.`);
        }
        await setDocument('shopItems', key, { price, description, originalName: itemName });
        await message.reply(`✅ Added **${itemName}** to the shop for **${price}** gems.`);
    }
    else if (command === 'shop-add-role' && isAdmin) {
        const itemName = args[0];
        const price = parseInt(args[1]);
        const role = message.mentions.roles.first();
        const descriptionMatch = message.content.match(/"(.*?)"/);
        const description = descriptionMatch ? descriptionMatch[1] : null;

        if (!itemName || isNaN(price) || price < 0 || !role || !description) {
            return message.reply(`Syntax: \`${PREFIX}shop-add-role <itemName> <price> @role "<description>"\``);
        }
        const key = itemName.toLowerCase();
        const existingItem = await getDocument('shopItems', key);
        if (existingItem) {
            return message.reply(`An item named "${itemName}" already exists in the shop.`);
        }
        await setDocument('shopItems', key, { price, description, roleId: role.id, originalName: itemName });
        await message.reply(`✅ Added the purchasable role **${itemName}** to the shop for **${price}** gems.`);
    }
    else if (command === 'shop-remove' && isAdmin) {
        const itemName = args[0];
        if (!itemName) {
            return message.reply(`Syntax: \`${PREFIX}shop-remove <itemName>\``);
        }
        const key = itemName.toLowerCase();
        const existingItem = await getDocument('shopItems', key);
        if (!existingItem) {
            return message.reply(`Could not find an item named "${itemName}" in the shop.`);
        }
        await deleteDocument('shopItems', key);
        await message.reply(`✅ Removed **${itemName}** from the shop.`);
    }
    else if (command === 'item-give' && isAdmin) {
        const targetMember = message.mentions.members.first();
        const itemName = args[1];
        const amount = parseInt(args[2]) || 1;

        if (!targetMember || !itemName || amount <= 0) {
            return message.reply(`Syntax: \`${PREFIX}item-give @player <itemName> [amount]\``);
        }

        const description = "Given by an admin.";
        const key = itemName.toLowerCase();

        const playerData = await getDocument('players', targetMember.id) || createDefaultProfile(targetMember);
        const inventory = playerData.inventory || {};
        const currentItem = inventory[key] || { count: 0, description: description };
        currentItem.count += amount;
        inventory[key] = currentItem;

        await setDocument('players', targetMember.id, { inventory, displayName: targetMember.displayName });
        await message.reply(`✅ Gave **${amount}x ${itemName}** to **${targetMember.displayName}**.`);
    }
    else if (command === 'item-take' && isAdmin) {
        const targetMember = message.mentions.members.first();
        const itemName = args[1];
        const amount = parseInt(args[2]) || 1;

        if (!targetMember || !itemName || amount <= 0) {
            return message.reply(`Syntax: \`${PREFIX}item-take @player <itemName> [amount]\``);
        }

        const playerData = await getDocument('players', targetMember.id);
        const key = itemName.toLowerCase();
        if (!playerData || !playerData.inventory || !playerData.inventory[key]) {
            return message.reply(`**${targetMember.displayName}** does not have any "${itemName}".`);
        }

        const inventory = playerData.inventory;
        const currentItem = inventory[key];
        const takenAmount = Math.min(amount, currentItem.count);
        currentItem.count -= takenAmount;

        if (currentItem.count <= 0) {
            delete inventory[key];
        }

        await setDocument('players', targetMember.id, { inventory });
        await message.reply(`✅ Took **${takenAmount}x ${itemName}** from **${targetMember.displayName}**.`);
    }
    // --- NEW: Player Economy Commands ---
    else if (command === 'bal' || command === 'balance') {
        if (!isPlayer && !isAlt && !isAdmin) return message.reply('You must have the "Thriving" or "Alt" role to use this command.');
        if (!isAllowedInRoleChannel(message, isAdmin, isAlt)) return;
        const playerData = await getDocument('players', message.author.id);
        const balance = playerData?.wallet || 0;
        await message.reply(`💎 Your current balance is **${balance}** gems.`);
    }
    else if (command === 'daily') {
        if (!isPlayer && !isAlt && !isAdmin) return message.reply('You must have the "Thriving" or "Alt" role to use this command.');
        if (!isAllowedInRoleChannel(message, isAdmin, isAlt)) return;

        const playerData = await getDocument('players', message.author.id);
        const lastClaim = playerData?.lastDailyClaim || 0;
        const now = Date.now();

        if (lastClaim && (now - lastClaim < DAILY_COOLDOWN)) {
            const timeLeft = DAILY_COOLDOWN - (now - lastClaim);
            const hours = Math.floor(timeLeft / (1000 * 60 * 60));
            const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
            return message.reply(`You have already claimed your daily gems. Please wait **${hours}h ${minutes}m**.`);
        }

        const newBal = (playerData?.wallet || 0) + DAILY_AMOUNT;
        await setDocument('players', message.author.id, { wallet: newBal, lastDailyClaim: now });

        await message.reply(`🎉 You have claimed your daily **${DAILY_AMOUNT}** gems! Your new balance is ${newBal}.`);
    }
    else if (command === 'shop') {
        if (!isPlayer && !isAlt && !isAdmin) return message.reply('You must have the "Thriving" or "Alt" role to use this command.');
        if (!isAllowedInRoleChannel(message, isAdmin, isAlt)) return;
        const shopSnapshot = await getDocs(collection(db, 'shopItems'));
        if (shopSnapshot.empty) {
            return message.reply('The shop is currently empty.');
        }

        const shopEmbed = new EmbedBuilder()
            .setColor('Gold')
            .setTitle('🛒 Item Shop')
            .setDescription(`Use \`${PREFIX}buy <Item-Name>\` to purchase an item.`);

        shopSnapshot.forEach(doc => {
            const item = doc.data();
            shopEmbed.addFields({ name: `${item.originalName} - ${item.price} 💎`, value: item.description });
        });
        await message.channel.send({ embeds: [shopEmbed] });
    }
    else if (command === 'inv' || command === 'inventory') {
        if (!isPlayer && !isAlt && !isAdmin) return message.reply('You must have the "Thriving" or "Alt" role to use this command.');
        if (!isAllowedInRoleChannel(message, isAdmin, isAlt)) return;
        const playerData = await getDocument('players', message.author.id);
        const inventory = playerData?.inventory;
        if (!inventory || Object.keys(inventory).length === 0) {
            return message.reply("Your inventory is empty.");
        }

        const invEmbed = new EmbedBuilder()
            .setColor('Blue')
            .setTitle(`${message.member.displayName}'s Inventory`);

        for (const [key, item] of Object.entries(inventory)) {
            const shopItem = await getDocument('shopItems', key);
            const displayName = shopItem ? shopItem.originalName : key;
            invEmbed.addFields({ name: `${displayName} (x${item.count})`, value: item.description });
        }
        await message.channel.send({ embeds: [invEmbed] });
    }
    else if (command === 'buy') {
        if (!isPlayer && !isAlt && !isAdmin) return message.reply('You must have the "Thriving" or "Alt" role to use this command.');
        if (!isAllowedInRoleChannel(message, isAdmin, isAlt)) return;

        const itemName = args[0];
        const amount = parseInt(args[1]) || 1;

        if (!itemName || amount <= 0) {
            return message.reply(`Syntax: \`${PREFIX}buy <itemName> [amount]\``);
        }

        const key = itemName.toLowerCase();
        const shopItem = await getDocument('shopItems', key);

        if (!shopItem) {
            return message.reply(`I couldn't find an item named "${itemName}" in the shop.`);
        }

        const totalCost = shopItem.price * amount;

        try {
            await runTransaction(db, async (transaction) => {
                const playerDocRef = doc(db, 'players', message.author.id);
                const playerDoc = await transaction.get(playerDocRef);
                const playerData = playerDoc.exists() ? playerDoc.data() : createDefaultProfile(message.member);

                const balance = playerData.wallet || 0;
                if (balance < totalCost) {
                    throw new Error(`You don't have enough gems. You need **${totalCost}** but you only have **${balance}**.`);
                }

                playerData.wallet -= totalCost;

                const inventory = playerData.inventory || {};
                const currentItem = inventory[key] || { count: 0, description: shopItem.description };
                currentItem.count += amount;
                inventory[key] = currentItem;
                playerData.inventory = inventory;

                transaction.set(playerDocRef, playerData, { merge: true });
            });

            if (shopItem.roleId) {
                try {
                    const role = await guild.roles.fetch(shopItem.roleId);
                    if (role) {
                        await message.member.roles.add(role);
                    }
                } catch (error) {
                    console.error(`Failed to add role ${shopItem.roleId} on purchase:`, error);
                }
            }

            await message.reply(`✅ You successfully purchased **${amount}x ${shopItem.originalName}** for **${totalCost}** gems!`);

        } catch (e) {
            console.error("Transaction failed: ", e);
            await message.reply(e.message || "An error occurred during your purchase. Please try again.");
        }
    }
    else if (command === 'whisper') {
        if (!isPlayer && !isAlt && !isAdmin) {
            return message.reply('You must have the "Thriving" or "Alt" role to use this command.');
        }
        if (!isAllowedInRoleChannel(message, isAdmin, isAlt)) return;
    
        const whisperItemKey = 'whisper';
        const playerData = await getDocument('players', message.author.id);
        const inventory = playerData?.inventory || {};
        const whisperItem = inventory[whisperItemKey];
    
        if (!whisperItem || whisperItem.count <= 0) {
            return message.reply(`You don't have a "${whisperItemKey}" item to use this command. You can buy one from the \`.shop\`.`);
        }
    
        const type = args[0]?.toLowerCase();
        const messageMatch = message.content.match(/"(.*?)"/);
        const whisperMessage = messageMatch ? messageMatch[1] : null;
    
        if (!['anonymous', 'regular'].includes(type) || !whisperMessage) {
            return message.reply(`Invalid syntax. Use: \`${PREFIX}whisper <anonymous|regular> "message" <target-name>\``);
        }
    
        const targetName = message.content.substring(messageMatch.index + messageMatch[0].length).trim();
        if (!targetName) {
            return message.reply(`You must specify a target player's name. Use: \`${PREFIX}whisper <anonymous|regular> "message" <target-name>\``);
        }
    
        const targetMember = guild.members.cache.find(m => m.displayName.toLowerCase() === targetName.toLowerCase());
    
        if (!targetMember) {
            return message.reply(`Could not find a player with the name "${targetName}".`);
        }
    
        if (targetMember.id === message.author.id) {
            return message.reply("You cannot whisper to yourself.");
        }
        if (!targetMember.roles.cache.some(r => r.name === 'Thriving' || r.name === 'Alt')) {
            return message.reply("You can only whisper to other Thriving players or Alts.");
        }
    
        const gameState = await getGameState();
        const words = whisperMessage.trim().split(/\s+/);
        if (words.length > gameState.whisperWordLimit) {
            return message.reply(`Your whisper is too long. The maximum length is **${gameState.whisperWordLimit}** words.`);
        }
    
        const targetRoleChannel = await getPlayerRoleChannel(guild, targetMember);
        if (!targetRoleChannel) {
            return message.reply(`I could not find the role channel for **${targetMember.displayName}**.`);
        }
    
        // Consume the item
        whisperItem.count--;
        if (whisperItem.count <= 0) {
            delete inventory[whisperItemKey];
        }
        await setDocument('players', message.author.id, { inventory });
    
        // Send the whisper
        if (type === 'anonymous') {
            await targetRoleChannel.send(`🤫 A mysterious whisper arrives: *"${whisperMessage}"*`);
        } else { // regular
            await targetRoleChannel.send(`🗣️ A whisper arrives from **${message.member.displayName}**: *"${whisperMessage}"*`);
        }
    
        await message.reply({ content: `Your whisper has been sent to **${targetMember.displayName}**. You have ${whisperItem.count} whisper(s) left.`, ephemeral: true });
    }
    else if (command === 'sos') {
        if (!isPlayer && !isAlt && !isAdmin) {
            return message.reply('You must have the "Thriving" or "Alt" role to use this command.');
        }
        if (!isAllowedInRoleChannel(message, isAdmin, isAlt)) return;

        const sosItemKey = 'sos';
        const playerData = await getDocument('players', message.author.id);
        const inventory = playerData?.inventory || {};
        const sosItem = inventory[sosItemKey];

        if (!sosItem || sosItem.count <= 0) {
            return message.reply(`You don't have an "sos" item to use this command. You can buy one from the \`.shop\`.`);
        }
        
        // Consume the item
        sosItem.count--;
        if (sosItem.count <= 0) {
            delete inventory[sosItemKey];
        }
        await setDocument('players', message.author.id, { inventory });

        // Find current location
        const assignmentsRef = collection(db, 'shipAssignments');
        const q = query(assignmentsRef, where('occupants', 'array-contains', message.author.id));
        const assignmentsSnapshot = await getDocs(q);

        if (assignmentsSnapshot.empty) {
            return message.reply("You are not currently in a spaceship to send an SOS from.");
        }

        const shipId = assignmentsSnapshot.docs[0].id;
        const shipChannel = guild.channels.cache.get(shipId);

        if (!shipChannel) {
            return message.reply("Could not identify your current location.");
        }

        const announcementChannel = guild.channels.cache.find(c => c.name === 'announcement');
        if (!announcementChannel) {
            return message.reply("Could not find the announcement channel to send the SOS.");
        }

        const thrivingRole = guild.roles.cache.find(r => r.name === 'Thriving');
        const partnerRole = guild.roles.cache.find(r => r.name === 'Partner');
        const challengerRole = guild.roles.cache.find(r => r.name === 'Challenger');
        const pingText = `${thrivingRole || ''} ${partnerRole || ''} ${challengerRole || ''}`;

        await announcementChannel.send(`${pingText}\n🚨 **SOS!** An emergency signal has been received from **${message.member.displayName}** located at **${shipChannel.toString()}**!`);
        await message.reply({ content: `Your SOS has been broadcasted. You have ${sosItem.count} SOS item(s) left.`, ephemeral: true });
    }
    else if (command === 'countday') {
        const targetMember = message.mentions.members.first() || message.member;
        if (!isAdmin && targetMember.id !== message.author.id) {
            return message.reply("You can only check your own message count.");
        }

        const dayDiscussionChannel = guild.channels.cache.find(c => c.name === 'day-discussion');
        if (!dayDiscussionChannel) {
            return message.reply('Could not find the #day-discussion channel.');
        }

        let messageCount = 0;
        let lastMessageId;
        while (true) {
            const options = { limit: 100 };
            if (lastMessageId) {
                options.before = lastMessageId;
            }
            const messages = await dayDiscussionChannel.messages.fetch(options);
            if (messages.size === 0) {
                break;
            }
            messageCount += messages.filter(m => m.author.id === targetMember.id).size;
            lastMessageId = messages.last().id;
        }

        await message.reply(`**${targetMember.displayName}** has sent **${messageCount}** messages in #day-discussion.`);
    }
    else if (command === 'count' && isAdmin) {
        await message.reply(`Counting messages for all thriving players across all game channels. This may take a very long time...`);

        const thrivingRole = guild.roles.cache.find(r => r.name === 'Thriving');
        if (!thrivingRole) return message.reply('Thriving role not found.');
        await guild.members.fetch();
        const thrivingMembers = thrivingRole.members;

        const totalCounts = new Map(thrivingMembers.map(m => [m.id, 0]));
        const channelCounts = new Map();

        const categoriesToScan = [
            'DAYTIME', 'PUBLIC CHANNELS', 'PRIVATE CHANNELS', 'SPECIAL LOCATION',
            'CLOSED PUBLIC CHANNELS', 'CLOSED PRIVATE CHANNELS', 'CLOSED SPECIAL CHANNELS'
        ];

        for (const catName of categoriesToScan) {
            const category = guild.channels.cache.find(c => c.name === catName && c.type === ChannelType.GuildCategory);
            if (category) {
                for (const channel of category.children.cache.values()) {
                    if (channel.type === ChannelType.GuildText) {
                        channelCounts.set(channel.name, new Map(thrivingMembers.map(m => [m.id, 0])));
                        try {
                            let lastMessageId;
                            while (true) {
                                const options = { limit: 100 };
                                if (lastMessageId) {
                                    options.before = lastMessageId;
                                }
                                const messages = await channel.messages.fetch(options);
                                if (messages.size === 0) break;

                                messages.forEach(msg => {
                                    if (totalCounts.has(msg.author.id)) {
                                        totalCounts.set(msg.author.id, totalCounts.get(msg.author.id) + 1);
                                        channelCounts.get(channel.name).set(msg.author.id, channelCounts.get(channel.name).get(msg.author.id) + 1);
                                    }
                                });
                                lastMessageId = messages.last().id;
                            }
                        } catch (err) {
                            console.error(`Could not fetch messages from ${channel.name}: ${err.message}`);
                        }
                    }
                }
            }
        }

        const sortedTotal = [...totalCounts.entries()].sort((a, b) => b[1] - a[1]);
        const embeds = [];
        let currentEmbed = new EmbedBuilder()
            .setColor('Gold')
            .setTitle('Message Count Leaderboard');
        let fieldCount = 0;

        for (const [index, [userId, totalCount]] of sortedTotal.entries()) {
            if (totalCount === 0) continue;

            const member = guild.members.cache.get(userId);
            if (!member) continue;

            let channelBreakdown = '';
            for (const [channelName, counts] of channelCounts.entries()) {
                const countInChannel = counts.get(userId) || 0;
                if (countInChannel > 0) {
                    const nextLine = `**#${channelName}**: ${countInChannel}\n`;
                    if (channelBreakdown.length + nextLine.length > 1024) {
                        channelBreakdown += '...and more.';
                        break;
                    }
                    channelBreakdown += nextLine;
                }
            }

            if (fieldCount === 25) {
                embeds.push(currentEmbed);
                currentEmbed = new EmbedBuilder()
                    .setColor('Gold')
                    .setTitle('Message Count Leaderboard (Cont.)');
                fieldCount = 0;
            }

            currentEmbed.addFields({
                name: `${index + 1}. ${member.displayName} - ${totalCount} total messages`,
                value: channelBreakdown || 'No messages in tracked channels.'
            });
            fieldCount++;
        }

        embeds.push(currentEmbed);

        if (embeds[0].data.fields.length === 0) {
            return message.channel.send("No messages found from thriving players in any of the tracked channels.");
        }

        for (const embed of embeds) {
            await message.channel.send({ embeds: [embed] });
        }
    }
        else if (command === 'info') {

        const infoEmbed = new EmbedBuilder()

            .setColor('#0099ff')

            .setTitle('🤖 Baby Yoda Bot - Command Reference')

            .setDescription('A detailed guide to all available commands. \n `[Admin]` indicates an Administrator-only command. \n `[Player]` indicates a command for users with the "Thriving" or "Alt" role.')

            .addFields(

                {

                    name: '🛠️ World & Game Setup `[Admin]`',

                    value: `\`${PREFIX}create\` - Builds the entire game world, including channels and roles.\n` +

                        `\`${PREFIX}verysussybaka\` - **DANGER!** Deletes ALL game channels and roles.`

                },

                {

                    name: '👤 Player & Profile Management `[Admin]`',

                    value: `\`${PREFIX}thriving @Player1 @Player2...\` - Assigns the 'Thriving' role and a home ship.\n` +

                        `\`${PREFIX}alt @Player1 @Player2...\` - Assigns the 'Alt' role.\n` +

                        `\`${PREFIX}challenger @Player1 @Player2...\` - Assigns the 'Challenger' role and a waiting room channel.\n` +

                        `\`${PREFIX}giveos @Player\` - Grants the Overseer (admin) role to a player.\n` +

                        `\`${PREFIX}dead @Player\` - Kills a player, revoking roles and moving their channel.\n` +

                        `\`${PREFIX}alive @Player\` - Revives a dead player, assigning a new home ship.\n` +

                        `\`${PREFIX}deleteprofile @Player\` - Deletes a player's profile and all associated data.`

                },

                {

                    name: '\u200B',

                    value: `\`${PREFIX}addpartner @Player @Partner\` - Assigns a partner who will follow a player.\n` +

                        `\`${PREFIX}set-role-profile @Player <Role Name> <Team>\` - Sets a player's role name and team.\n` +

                        `\`${PREFIX}set-lore @player "<lore text>"\` - Sets a player's lore.\n` +

                        `\`${PREFIX}set-categories @Player <Cat1> <Cat2>...\` - Sets a player's ability categories.\n` +

                        `\`${PREFIX}set-visits @Player <day|night> <reg|spec|stealth> <count>\` - Sets visit counts.\n` +

                        `\`${PREFIX}add-visits @Player <d_r> <d_s> <d_st> <n_r> <n_s> <n_st>\` - Adds visits to a player's total.\n` +

                        `\`${PREFIX}setspecialcount @Player <count>\` - Sets special location entry count.\n` +

                        `\`${PREFIX}add-ability @Player <active|passive> <args>\` - Adds an ability to a profile.`

                },

                {

                    name: '💎 Currency & Items `[Admin]`',

                    value: `\`${PREFIX}gem-give @Player <amount>\` - Gives gems to a player.\n` +

                        `\`${PREFIX}gem-take @Player <amount>\` - Takes gems from a player.\n` +

                        `\`${PREFIX}gem-set @Player <amount>\` - Sets a player's gem balance.\n` +

                        `\`${PREFIX}item-give @Player <itemName> [amount]\` - Gives an item to a player.\n` +

                        `\`${PREFIX}item-take @Player <itemName> [amount]\` - Takes an item from a player.`

                },

                {

                    name: '🛒 Shop Management `[Admin]`',

                    value: `\`${PREFIX}shop-add <itemName> <price> "<description>"\` - Adds an item to the shop.\n` +

                        `\`${PREFIX}shop-add-role <itemName> <price> @role "<description>"\` - Adds a purchasable role to the shop.\n` +

                        `\`${PREFIX}shop-remove <itemName>\` - Removes an item from the shop.`

                },

                {

                    name: '🚀 Ship & Channel Control `[Admin]`',

                    value: `\`${PREFIX}teleport @player #ship\` - Instantly move a player.\n` +

                        `\`${PREFIX}sethome @player #ship\` - Change a player's home ship.\n` +

                        `\`${PREFIX}backhome\` - Force all players to return home.\n` +

                        `\`${PREFIX}close\` - Move a public/private channel to a closed category.\n` +

                        `\`${PREFIX}destroy #ship\` - Move a spaceship to the 'destroyed' category.\n` +

                        `\`${PREFIX}revive #ship\` - Restore a destroyed spaceship.\n` +

                        `\`${PREFIX}destroydoor #ship\` - Make a ship's door permanently open.\n` +

                        `\`${PREFIX}public\` - (In a ship) Make it viewable by all players.\n` +

                        `\`${PREFIX}pc <public|private> <name> @P1...\` - Create a public/private chat.`

                },

                {

                    name: '✨ Location Modifiers `[Admin]`',

                    value: `\`${PREFIX}special_to_regular #ship <yes|no>\` - Downgrade special visits.\n` +

                        `\`${PREFIX}stealth_to_regular #ship <yes|no>\` - Downgrade stealth visits.\n` +

                        `\`${PREFIX}sls <head|maxallow|time> @player\` - Manages St. Lazarus Spire.\n` +

                        `\`${PREFIX}blackhole <head|maxallow|time> @player\` - Manages the Black Hole.\n` +

                        `\`${PREFIX}cygnus <head|maxallow|time> @player\` - Manages the Cygnus Exchange.\n` +

                        `\`${PREFIX}la <head|maxallow|time> @player\` - Manages La Famiglia Galattica.`

                },

                {

                    name: '▶️ Game Flow & Control `[Admin]`',

                    value: `\`${PREFIX}day\` / \`${PREFIX}night\` - Transitions the game phase and **locks** visits.\n` +

                        `\`${PREFIX}allowvisits\` - Unlocks the \`.visit\` command for the current phase.\n` +

                        `\`${PREFIX}setknocktimer <minutes>\` - Sets the auto-open timer for knocks.\n` +

                        `\`${PREFIX}setwhisperlimit <number>\` - Sets the word limit for whispers.\n` +

                        `\`${PREFIX}vote #voting-channel-x\` - Starts a voting session in a channel.\n` +

                        `\`${PREFIX}votereset [#channel]\` - Resets one or all voting sessions.\n` +

                        `\`${PREFIX}manipulate @Voter [@Target]\` - Forces one player to vote for another (or themselves).\n` +

                        `\`${PREFIX}visitblock @Player <yes|no>\` - Blocks or unblocks a player from visiting.`

                },

                {

                    name: '🔍 Information & Logs `[Admin]`',

                    value: `\`${PREFIX}where @Player\` - Shows all channels a player is currently in.\n` +

                        `\`${PREFIX}list-ships\` - Lists all unoccupied spaceship channels.\n` +

                        `\`${PREFIX}who @role\` - Lists all players with a specific role.\n` +

                        `\`${PREFIX}allpresets\` - Shows all submitted player presets, sorted by priority.\n` +

                        `\`${PREFIX}actions @Player\` - Lists a player's logged actions.\n` +

                        `\`${PREFIX}actions @Player <add|delete> <args>\` - Manages a player's action logs.\n` +

                        `\`${PREFIX}count\` - Shows message leaderboards for thriving players.\n` +

                        `\`${PREFIX}countday\` - Shows message leaderboard for #day-discussion.`

                },

                {

                    name: '🚀 Player Actions `[Player]`',

                    value: `\`${PREFIX}profile\` - View your profile in your private channel.\n` +

                        `\`${PREFIX}bal\` / \`${PREFIX}balance\` - Check your gem balance.\n` +

                        `\`${PREFIX}daily\` - Claim your daily 150 gems.\n` +

                        `\`${PREFIX}shop\` - View the items available for purchase.\n` +

                        `\`${PREFIX}buy <itemName> [amount]\` - Purchase an item from the shop.\n` +

                        `\`${PREFIX}inv\` / \`${PREFIX}inventory\` - View your purchased items.\n` +

                        `\`${PREFIX}home\` - Return to your assigned home ship.\n` +

                        `\`${PREFIX}movein #spaceship-channel\` - Request to make your currently visited ship your new home.`

                },

                {

                    name: '\u200B',

                    value: `\`${PREFIX}preset <ability-code> <target>\` - Sets your action (e.g., \`.preset s1 @Player\`).\n` +

                        `\`${PREFIX}action <ability-code> "<description>"\` - Logs a custom action for admins.\n` +

                        `\`${PREFIX}whisper <anon|reg> "msg" <target-name>\` - Sends a private message if you own a 'whisper' item.\n`+

                        `\`${PREFIX}sos\` - Broadcasts your location if you own an 'sos' item.\n` +

                        `\`${PREFIX}visit <regular|special|stealth> <ship-number>\` - Visit another spaceship.\n` +

                        `\`${PREFIX}visitspecial <1-4>\` - Access a special location during the night.\n` +

                        `\`${PREFIX}vote @Player\` - Cast or change your vote in an active voting channel.\n`+

                        `\`${PREFIX}w\` - Lists all players with the 'Thriving' role.`

                },

                {

                    name: 'ℹ️ General',

                    value: `\`${PREFIX}info\` - Displays this help message.`

                }

            )

            .setFooter({ text: 'May the Force be with you' });



        await message.channel.send({ embeds: [infoEmbed] });

    }
});

async function checkExpiredLobbies() {
    const now = Date.now();
    const lobbiesRef = collection(db, 'specialLocationLobbies');
    const q = query(lobbiesRef, where('expiryTimestamp', '<=', now));

    try {
        const snapshot = await getDocs(q);
        if (snapshot.empty) return;

        console.log(`Found ${snapshot.size} expired special location lobbies to clean up.`);

        for (const lobbyDoc of snapshot.docs) {
            const { guildId, channelId, messageId } = lobbyDoc.data();
            const playerId = lobbyDoc.id;

            const guild = await client.guilds.fetch(guildId).catch(() => null);
            if (!guild) continue;

            const channel = await guild.channels.fetch(channelId).catch(() => null);
            const member = await guild.members.fetch(playerId).catch(() => null);

            if (channel) {
                await channel.permissionOverwrites.delete(playerId, 'Lobby session expired.').catch(console.error);
                const message = await channel.messages.fetch(messageId).catch(() => null);
                if (message) await message.delete().catch(console.error);
            }

            if (member) {
                const roleChannel = await getPlayerRoleChannel(guild, member);
                roleChannel?.send('Your session in the special location lobby has expired.');
            }

            await deleteDocument('specialLocationLobbies', playerId);
        }
    } catch (error) {
        console.error("Error checking for expired lobbies:", error);
    }
}

// --- Bot Login ---
client.login(BOT_TOKEN);