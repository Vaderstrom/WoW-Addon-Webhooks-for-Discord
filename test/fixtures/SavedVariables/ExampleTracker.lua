
ExampleTrackerDB = {
	["settings"] = {
		["secret"] = "never read by the app",
	},
	["webhooks"] = {
		["format"] = 1,
		["groups"] = {
			["team-1"] = {
				["name"] = "The Lanterns",
				["sub"] = "4 players · Season 2",
				["saved"] = 1800000000,
				["by"] = "Lea-Realm",
				["color"] = "2FA4A9",
				["kept"] = {
					["standings"] = {
						["text"] = "The Lanterns  ·  3 wins, 1 loss",
						["data"] = {
							["rows"] = {
								{ ["name"] = "Lea", ["score"] = 12 },
								{ ["name"] = "Mira", ["score"] = 9 },
								{ ["name"] = "Pata", ["score"] = 7 },
							},
						},
					},
				},
				["news"] = {
					{ ["id"] = "win:3", ["kind"] = "win", ["time"] = 1800000000, ["text"] = "The Lanterns won against the Gnomes, 3-1.", ["name"] = "Gnomes", ["picture"] = "Media/Icon.tga",
						["screenshot"] = 1800000001, ["fields"] = { ["opponent"] = "Gnomes", ["who"] = { "Lea", "Mira" }, ["score"] = 3 } },
					{ ["id"] = "lvl:lea:20", ["kind"] = "level", ["time"] = 1799999000, ["text"] = "Lea reached level 20.", ["fields"] = { ["level"] = "20" } },
					{ ["id"] = "odd", ["kind"] = "unknown", ["time"] = 1799999000, ["text"] = "A kind the plugin does not have." },
				},
				["numbers"] = { ["Lea"] = 20, ["Mira"] = 18 },
			},
		},
	},
}
